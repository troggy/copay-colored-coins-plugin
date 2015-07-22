'use strict';

angular.module('copayAddon.coloredCoins').controller('assetsController', function ($rootScope, $scope, $modal, $controller, $timeout, $log, coloredCoins, gettext, profileService, lodash, bitcore, externalTxSigner, UTXOList) {
  var self = this;

  this.assets = [];

  var addressToPath = {};

  this.setOngoingProcess = function(name) {
    $rootScope.$emit('Addon/OngoingProcess', name);
  };

  $rootScope.$on('Local/BalanceUpdated', function (event, balance) {
    self.assets = [];
    addressToPath = lodash.reduce(balance.byAddress, function(result, n) { result[n.address] = n.path; return result; }, {});
    if (balance.byAddress.length > 0) {
      self.setOngoingProcess(gettext('Getting assets'));
    }

    var checkedAddresses = 0;
    var assetsById = {};
    balance.byAddress.forEach(function (ba) {
      coloredCoins.getAssets(ba.address, function (assets) {
        lodash.each(assets, function(a) {
          var asset = assetsById[a.assetId];
          if (asset) {
            asset.amount += a.amount;
            asset.utxos = asset.utxos.concat(a.utxos);
          } else {
            assetsById[a.assetId] = a;
          }
          lodash.each(a.utxos, function(utxo) {
            utxo.path = addressToPath[ba.address];
            UTXOList.add(utxo.txid, utxo);
          });
        });
        if (++checkedAddresses == balance.byAddress.length) {
          self.assets = lodash.values(assetsById);
          self.setOngoingProcess();
        }
      })
    });
  });

  this.openTransferModal = function(asset) {

    var AssetTransferController = function($rootScope, $scope, $modalInstance, $timeout, $log, coloredCoins, gettext,
                                           profileService, lodash, bitcore, externalTxSigner) {
      $scope.asset = asset;

      $scope.fee = coloredCoins.defaultFee();

      $scope.error = '';

      $scope.cancel = function() {
        $modalInstance.dismiss('cancel');
      };

      $scope.resetError = function() {
        this.error = this.success = null;
      };

      var setOngoingProcess = function(name) {
        $rootScope.$emit('Addon/OngoingProcess', name);
      };

      var setTransferError = function(err) {
        var fc = profileService.focusedClient;
        $log.warn(err);
        var errMessage =
            fc.credentials.m > 1 ? gettext('Could not create asset transfer proposal') : gettext('Could not transfer asset');

        //This are abnormal situations, but still err message will not be translated
        //(the should) we should switch using err.code and use proper gettext messages
        err.message = err.error ? err.error : err.message;
        errMessage = errMessage + '. ' + (err.message ? err.message : gettext('Check you connection and try again'));

        $scope.error = errMessage;

        $timeout(function() {
          $scope.$digest();
        }, 1);
      };

      var handleTransferError = function(err) {
        profileService.lockFC();
        setOngoingProcess();
        return setTransferError(err);
      };

      var signAndBroadcast = function(txIndex, txs, cb) {
        var totalTxs = txs.length;
        if (txIndex >= totalTxs - 1) {
          return cb();
        }

        var tx = new bitcore.Transaction(txs[txIndex].txHex);
        $log.debug(JSON.stringify(tx.toObject(), null, 2));

        setOngoingProcess(gettext('Signing transaction ' + (txIndex + 1) + " of " + totalTxs));
        externalTxSigner.sign(tx, fc.credentials);

        setOngoingProcess(gettext('Broadcasting transaction ' + (txIndex + 1) + " of " + totalTxs));
        coloredCoins.broadcastTx(tx.uncheckedSerialize(), function(err, body) {
          if (err) { return handleTransferError(err); }
          $log.debug("Tx " + (txIndex + 1) + " has been broadcasted");
          signAndBroadcast(++txIndex, txs, cb);
        });
      };

      $scope.transferAsset = function(transfer, form) {
        $log.debug(asset);
        $log.debug(transfer);

        var fc = profileService.focusedClient;

        if (form.$invalid) {
          this.error = gettext('Unable to send transaction proposal');
          return;
        }

        if (fc.isPrivKeyEncrypted()) {
          profileService.unlockFC(function(err) {
            if (err) return setTransferError(err);
            return $scope.transferAsset(transfer, form);
          });
          return;
        }

        setOngoingProcess(gettext('Creating transfer transactions'));
        coloredCoins.createTransferTxs(asset, transfer._amount, transfer._address, self.assets, function(err, transferTxs) {
          if (err) { return handleTransferError(err); }

          signAndBroadcast(0, transferTxs, function() {
            $scope.cancel();
            $rootScope.$emit('NewOutgoingTx');
          });
        });
      };
    };

    var modalInstance = $modal.open({
      templateUrl: 'colored-coins/views/modals/send.html',
      windowClass: 'full animated slideInUp',
      controller: AssetTransferController
    });

    modalInstance.result.finally(function() {
      var m = angular.element(document.getElementsByClassName('reveal-modal'));
      m.addClass('slideOutDown');
    });
  };

  this.openAssetModal = function (asset) {
    var ModalInstanceCtrl = function($scope, $modalInstance) {
      $scope.asset = asset;
      $scope.openTransferModal = self.openTransferModal;
      $scope.cancel = function() {
        $modalInstance.dismiss('cancel');
      };
    };
    var modalInstance = $modal.open({
      templateUrl: 'colored-coins/views/modals/asset-details.html',
      windowClass: 'full animated slideInUp',
      controller: ModalInstanceCtrl
    });

    modalInstance.result.finally(function() {
      var m = angular.element(document.getElementsByClassName('reveal-modal'));
      m.addClass('slideOutDown');
    });
  };
  });