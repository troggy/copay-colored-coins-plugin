

var module = angular.module('copayAddon.coloredCoins', ['copayAssetViewTemplates']);

module.config(function(addonManagerProvider) {
  addonManagerProvider.registerAddon({
    menuItem: {
      'title': 'Assets',
      'icon': 'icon-pricetag',
      'link': 'assets'
    },
    view: {
      id: 'assets',
      'class': 'assets',
      template: 'colored-coins/views/assets.html'
    }
  });
});
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

        setOngoingProcess(gettext('Creating transfer transaction'));
        coloredCoins.createTransferTxs(asset, transfer._amount, transfer._address, self.assets, function(err, result) {
          if (err) { return handleTransferError(err); }

          lodash.each(result, function(transferTx) {
            var tx = new bitcore.Transaction(transferTx.txHex);
            $log.debug(JSON.stringify(tx.toObject(), null, 2));

            return;

            setOngoingProcess(gettext('Signing transaction'));
            externalTxSigner.sign(tx, fc.credentials);

            setOngoingProcess(gettext('Broadcasting transaction'));
            coloredCoins.broadcastTx(tx.uncheckedSerialize(), function(err, body) {
              if (err) { return handleTransferError(err); }
              $scope.cancel();
              $rootScope.$emit('NewOutgoingTx');
            });
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
'use strict';

angular.module('copayAddon.coloredCoins')
  .filter('stringify', function($sce) {
    return function(json) {
      json = json || [];
      return $sce.trustAsHtml(JSON.stringify(json, null, 4).replace(/\n/g, '<br>'));
    }
  });
'use strict';

angular.module('copayAddon.coloredCoins').service('UTXOList', function() {
  var root = {},
      txidToUTXO = {};

  root.add = function(txid, utxo) {
    txidToUTXO[txid] = utxo;
  };

  root.get = function(txid) {
    return txidToUTXO[txid];
  };

  return root;
});
'use strict';

function ColoredCoins(profileService, configService, bitcore, UTXOList, $http, $log, lodash) {
  var defaultConfig = {
    fee: 1000,
    api: {
      testnet: 'testnet.api.coloredcoins.org',
      livenet: 'api.coloredcoins.org'
    }
  };

  var config = (configService.getSync()['coloredCoins'] || defaultConfig),
      root = {};

  var apiHost = function(network) {
    if (!config['api'] || ! config['api'][network]) {
      return defaultConfig.api[network];
    } else {
      return config.api[network];
    }
  };

  var handleResponse = function (data, status, cb) {
    $log.debug('Status: ', status);
    $log.debug('Body: ', JSON.stringify(data));

    if (status != 200 && status != 201) {
      return cb(data);
    }
    return cb(null, data);
  };

  var getFrom = function (api_endpoint, param, network, cb) {
    $log.debug('Get from:' + api_endpoint + '/' + param);
    $http.get('http://' + apiHost(network) + '/v2/' + api_endpoint + '/' + param)
        .success(function (data, status) {
          return handleResponse(data, status, cb);
        })
        .error(function(data, status) {
          return handleResponse(data, status, cb);
        });
  };

  var postTo = function(api_endpoint, json_data, network, cb) {
    $log.debug('Post to:' + api_endpoint + ". Data: " + JSON.stringify(json_data));
    $http.post('http://' + apiHost(network) + '/v2/' + api_endpoint, json_data)
        .success(function (data, status) {
          return handleResponse(data, status, cb);
        })
        .error(function(data, status) {
          return handleResponse(data, status, cb);
        });
  };

  var extractAssets = function(utxos, address) {
    var assets = {};
    if (!utxos || utxos.length == 0) return assets;

    utxos.forEach(function(utxo) {
      if (utxo.assets || utxo.assets.length > 0) {
        utxo.assets.forEach(function(asset) {
          var assetList = assets[asset.assetId] || (assets[asset.assetId] = { assetId: asset.assetId, amount: 0, utxos: [] });
          var assetUtxo = lodash.pick(utxo, [ 'txid', 'index', 'value', 'scriptPubKey']);
          lodash.assign(assetUtxo, { amount: asset.amount, address: address })
          assetList.utxos.push(assetUtxo);
          assetList.amount += asset.amount;
        });
      }
    });

    return lodash.values(assets);
  };

  var getMetadata = function(asset, network, cb) {
    getFrom('assetmetadata', asset.assetId + "/" + asset.utxos[0].txid + ":" + asset.utxos[0].index, network, function(err, body){
      if (err) { return cb(err); }
      return cb(null, body.metadataOfIssuence);
    });
  };

  var getAssetsByAddress = function(address, network, cb) {
    getFrom('addressinfo', address, network, function(err, body) {
      if (err) { return cb(err); }
      return cb(null, extractAssets(body.utxos, address));
    });
  };

  root._rejectColoredUtxos = function(utxos, assets) {
    var coloredUtxos = lodash.reduce(assets, function(utxos, asset) {
      return utxos.concat(lodash.map(asset.utxos, function(utxo) {
        return utxo.txid + ":" + utxo.index;
      }));
    }, []);

    return lodash.reject(utxos, function(utxo) {
      return lodash.includes(coloredUtxos, utxo.txid + ":" + utxo.vout);
    });
  };

  root._selectFinanceOutput = function(fee, fc, assets, cb) {
    fc.getUtxos(function(err, utxos) {
      if (err) { return cb(err); }

      var colorlessUtxos = root._rejectColoredUtxos(utxos, assets);

      var selected = lodash.find(colorlessUtxos, function(u) {
        return u.satoshis >= fee;
      });

      if (!selected) {
        return cb({ error: "Insufficient funds for a fee" });
      }

      return cb(null, selected);
    });
  };

  root._selectAssetUtxos = function(amount, utxos) {
    // sort by amount descending
    utxos = lodash.sortBy(utxos, function(utxo) { return -utxo.amount; });

    var selected = [];
    var selectedAmount = 0;
    for (var i = 0; i < utxos.length; i++) {
      selectedAmount += utxos[i].amount;
      selected.push(utxos[i]);
      if (selectedAmount >= amount) {
        return selected;
      }
    }

    return null;
  };

  root.init = function() {};

  root.defaultFee = function() {
    return config.fee || defaultConfig.fee;
  };

  root.getAssets = function(address, cb) {
    var network = profileService.focusedClient.credentials.network;
    getAssetsByAddress(address, network, function(err, assetsInfo) {
      if (err) { return cb(err); }

      $log.debug("Assets for " + address + ": \n" + JSON.stringify(assetsInfo));

      var assets = [];
      assetsInfo.forEach(function(asset) {
        getMetadata(asset, network, function(err, metadata) {
          asset.metadata = metadata;
          assets.push(asset);
          if (assetsInfo.length == assets.length) {
            return cb(assets);
          }
        });
      });
      if (assetsInfo.length == assets.length) {
        return cb(assets);
      }
    });
  };

  root.broadcastTx = function(txHex, cb) {
    var network = profileService.focusedClient.credentials.network;
    postTo('broadcast', { txHex: txHex }, network, cb);
  };

  root.createTransferTxs = function(asset, amount, toAddress, assets, cb) {
    if (amount > asset.amount) {
      return cb({ error: "Cannot transfer more assets then available" }, null);
    }

    var assetUtxos = root._selectAssetUtxos(amount, asset.utxos);

    var leftToTransfer = amount;
    var transfers = [];
    lodash.each(assetUtxos, function(utxo) {
      var amountToTransfer = leftToTransfer > utxo.amount ? utxo.amount : leftToTransfer;
      leftToTransfer -= amountToTransfer;
      root._createTransferTx(asset.assetId, amountToTransfer, utxo, toAddress, assets, function(err, tx) {
        if (err) { return cb(err); }
        transfers.push(tx);
        if (transfers.length == assetUtxos.length) {
          cb(null, transfers);
        }
      })
    });
  };

  root._createTransferTx = function(assetId, amountToTransfer, assetUtxo, toAddress, assets, cb) {

    var fc = profileService.focusedClient;

    var to = [{
      "address": toAddress,
      "amount": amountToTransfer,
      "assetId": assetId
    }];

    // transfer the rest of asset back to our address
    if (amount < assetUtxo.amount) {
      to.push({
        "address": assetUtxo.address,
        "amount": assetUtxo.amount - amountToTransfer,
        "assetId": assetId
      });
    }

    var fee = root.defaultFee();

    root._selectFinanceOutput(fee, fc, assets, function(err, financeUtxo) {
      if (err) { return cb(err); }

      UTXOList.add(financeUtxo.txid, {
        txid: financeUtxo.txid, path: financeUtxo.path, index: financeUtxo.vout,
        value: financeUtxo.satoshis, publicKeys: financeUtxo.publicKeys,
        scriptPubKey: {
          hex: financeUtxo.scriptPubKey,
          reqSigs: fc.credentials.m
        }
      });

      var transfer = {
        from: assetUtxo.address,
        //sendutxo: assetUtxo.txid + ":" + assetUtxo.index,
        fee: fee,
        to: to,
        financeOutput: {
          value: financeUtxo.satoshis,
          n: financeUtxo.vout,
          scriptPubKey: {
            asm: new bitcore.Script(financeUtxo.scriptPubKey).toString(),
            hex: financeUtxo.scriptPubKey,
            type: 'scripthash'
          }
        },
        financeOutputTxid: financeUtxo.txid
      };

      $log.debug(JSON.stringify(transfer, null, 2));
      var network = fc.credentials.network;
      postTo('sendasset', transfer, network, cb);
    });
  };

  return root;
}


angular.module('copayAddon.coloredCoins').service('coloredCoins', ColoredCoins);

'use strict';

angular.module('copayAddon.coloredCoins').service('externalTxSigner', function(lodash, bitcore, UTXOList) {
  var root = {};

  function ExternalTxSigner(credentials) {

    this.derivePrivKeys = function(xPriv, network, tx) {
      var derived = {};
      var xpriv = new bitcore.HDPrivateKey(xPriv, network).derive("m/45'");
      for (var i = 0; i < tx.inputs.length; i++) {
        var path = UTXOList.get(tx.inputs[i].toObject().prevTxId).path;
        if (!derived[path]) {
          derived[path] = xpriv.derive(path).privateKey;
        }
      }
      return derived;
    };

    this.convertInputsToP2SH = function(tx, derivedPrivKeys) {
      var inputs = tx.inputs;
      tx.inputs = [];
      for (var i = 0; i < inputs.length; i++) {
        var input = inputs[i];
        var txid = input.toObject().prevTxId;
        var utxo = UTXOList.get(txid);
        var path = utxo.path;
        var pubKey = derivedPrivKeys[path].publicKey;
        var script = new bitcore.Script(utxo.scriptPubKey.hex).toString();
        var from = {'txId': txid, outputIndex: utxo.index, satoshis: utxo.value, script: script };
        tx.from(from, [pubKey], utxo.scriptPubKey.reqSigs);
      }
    };

    this.sign = function(tx) {
      //Derive proper key to sign, for each input
      var derivedPrivKeys = this.derivePrivKeys(credentials.xPrivKey, credentials.network, tx);

      this.convertInputsToP2SH(tx, derivedPrivKeys);

      // sign each input
      lodash.each(lodash.values(derivedPrivKeys), function(privKey) {
        tx.sign(privKey);
      });
    };

  }

  root.sign = function(tx, credentials) {
    return new ExternalTxSigner(credentials).sign(tx);
  };


  return root;
});
angular.module('copayAssetViewTemplates', ['colored-coins/views/assets.html', 'colored-coins/views/modals/asset-details.html', 'colored-coins/views/modals/send.html']);

angular.module("colored-coins/views/assets.html", []).run(["$templateCache", function($templateCache) {
  $templateCache.put("colored-coins/views/assets.html",
    "<div ng-show=\"assets.assets\" class=\"scroll\" ng-controller=\"assetsController as assets\">\n" +
    "    <div ng-repeat=\"asset in assets.assets\" ng-click=\"assets.openAssetModal(asset)\"\n" +
    "         class=\"row collapse last-transactions-content\">\n" +
    "        <div class=\"small-1 columns text-center\">\n" +
    "            <i class=\"icon-pricetag size-24\" style=\"margin-top:8px;\"></i>\n" +
    "            &nbsp;\n" +
    "        </div>\n" +
    "        <div class=\"small-4 columns\">\n" +
    "            <div ng-if=\"!$root.updatingBalance\">\n" +
    "                <span class=\"text-bold size-16\">{{ asset.metadata.data.assetName }}</span>\n" +
    "            </div>\n" +
    "            <div class=\"ellipsis text-gray size-14\">\n" +
    "                {{ asset.metadata.data.description }}\n" +
    "            </div>\n" +
    "        </div>\n" +
    "        <div class=\"small-2 columns\">\n" +
    "          <span class=\"size-16\">\n" +
    "            {{ asset.amount }} unit{{ asset.amount != 1 ? 's' : '' }}\n" +
    "          </span>\n" +
    "        </div>\n" +
    "        <div class=\"small-4 columns\">\n" +
    "            <span class=\"size-14\"><span translate>Issued by</span>: {{ asset.metadata.data.issuer }}</span>\n" +
    "        </div>\n" +
    "        <div class=\"small-1 columns text-right\">\n" +
    "            <i class=\"icon-arrow-right3 size-18\"></i>\n" +
    "        </div>\n" +
    "    </div>\n" +
    "</div>\n" +
    "<div class=\"extra-margin-bottom\"></div>\n" +
    "");
}]);

angular.module("colored-coins/views/modals/asset-details.html", []).run(["$templateCache", function($templateCache) {
  $templateCache.put("colored-coins/views/modals/asset-details.html",
    "<nav class=\"tab-bar\">\n" +
    "    <section class=\"left-small\">\n" +
    "        <a ng-click=\"cancel()\">\n" +
    "            <i class=\"icon-arrow-left3 icon-back\"></i>\n" +
    "            <span class=\"text-back\" translate>Back</span>\n" +
    "        </a>\n" +
    "    </section>\n" +
    "    <section class=\"middle tab-bar-section\">\n" +
    "        <h1 class=\"title ellipsis\" ng-style=\"{'color':color}\" translate>\n" +
    "            Asset\n" +
    "        </h1>\n" +
    "    </section>\n" +
    "</nav>\n" +
    "\n" +
    "<div class=\"modal-content\">\n" +
    "    <div class=\"header-modal text-center\">\n" +
    "        <div class=\"size-42\">\n" +
    "            {{ asset.metadata.data.assetName }}\n" +
    "        </div>\n" +
    "        <div class=\"size-18 m5t text-gray\" ng-show=\"btx.alternativeAmount\">\n" +
    "            {{ asset.metadata.data.description }}\n" +
    "        </div>\n" +
    "    </div>\n" +
    "\n" +
    "    <div>\n" +
    "        <div class=\"text-center m20t\">\n" +
    "            <button class=\"button outline round light-gray tiny\" ng-click=\"openTransferModal(asset)\">\n" +
    "                <span class=\"text-primary\" translate>Transfer</span>\n" +
    "            </button>\n" +
    "        </div>\n" +
    "    </div>\n" +
    "\n" +
    "\n" +
    "    <h4 class=\"title m0\" translate>Details</h4>\n" +
    "    <ul class=\"no-bullet size-14 m0\">\n" +
    "        <li class=\"line-b p10 oh\">\n" +
    "            <span class=\"text-gray\" translate>Amount</span>:\n" +
    "    <span class=\"right\">\n" +
    "      <time>{{ asset.amount }}</time>\n" +
    "    </span>\n" +
    "        </li>\n" +
    "        <li class=\"line-b p10 oh\">\n" +
    "            <span class=\"text-gray\" translate>Issuer</span>:\n" +
    "    <span class=\"right\">\n" +
    "      {{ asset.metadata.data.issuer }}\n" +
    "    </span>\n" +
    "        </li>\n" +
    "        <li class=\"line-b p10 oh\">\n" +
    "            <span class=\"text-gray\" translate>Raw metadata</span>:\n" +
    "            <pre class=\"right\" ng-bind-html=\"asset.metadata | stringify\"></pre>\n" +
    "        </li>\n" +
    "    </ul>\n" +
    "\n" +
    "    <div class=\"extra-margin-bottom\"></div>\n" +
    "</div>");
}]);

angular.module("colored-coins/views/modals/send.html", []).run(["$templateCache", function($templateCache) {
  $templateCache.put("colored-coins/views/modals/send.html",
    "<nav class=\"tab-bar\">\n" +
    "    <section class=\"left-small\">\n" +
    "        <a ng-click=\"cancel()\">\n" +
    "            <i class=\"icon-arrow-left3 icon-back\"></i>\n" +
    "            <span class=\"text-back\" translate>Back</span>\n" +
    "        </a>\n" +
    "    </section>\n" +
    "    <section class=\"middle tab-bar-section\">\n" +
    "        <h1 class=\"title ellipsis\" ng-style=\"{'color':color}\" translate>\n" +
    "            Asset\n" +
    "        </h1>\n" +
    "    </section>\n" +
    "</nav>\n" +
    "\n" +
    "<div class=\"modal-content\">\n" +
    "    <div class=\"header-modal text-center\">\n" +
    "        <div class=\"size-42\">\n" +
    "            {{ asset.metadata.data.assetName }}\n" +
    "        </div>\n" +
    "        <div class=\"size-18 m5t text-gray\" ng-show=\"btx.alternativeAmount\">\n" +
    "            {{ asset.metadata.data.description }}\n" +
    "        </div>\n" +
    "    </div>\n" +
    "\n" +
    "    <div class=\"row m20t\">\n" +
    "        <div class=\"large-12 large-centered columns\">\n" +
    "            <form name=\"assetTransferForm\" ng-submit=\"transferAsset(transfer, assetTransferForm)\" ng-disabled=\"home.blockUx || home.onGoingProcess\" novalidate>\n" +
    "                <div class=\"box-notification\" ng-show=\"error\" ng-click=\"resetError()\">\n" +
    "                  <span class=\"text-warning\">\n" +
    "                    {{ error|translate }}\n" +
    "                  </span>\n" +
    "                    <a class=\"close-notification text-warning\">&#215;</a>\n" +
    "                </div>\n" +
    "\n" +
    "                <div ng-hide=\"home.hideAddress\">\n" +
    "                    <div class=\"row collapse\">\n" +
    "                        <label for=\"address\" class=\"left\">\n" +
    "                            <span translate>To</span>\n" +
    "                        </label>\n" +
    "                        <span ng-hide=\"assetTransferForm.address.$pristine\">\n" +
    "                          <span class=\"has-error right size-12\" ng-show=\"assetTransferForm.address.$invalid && transfer._address\">\n" +
    "                            <i class=\"icon-close-circle size-14\"></i>\n" +
    "                            <span class=\"vm\" translate>Not valid</span>\n" +
    "                          </span>\n" +
    "                          <small class=\"right text-primary\" ng-show=\"!assetTransferForm.address.$invalid\">\n" +
    "                              <i class=\"icon-checkmark-circle size-14\"></i>\n" +
    "                          </small>\n" +
    "                        </span>\n" +
    "                    </div>\n" +
    "\n" +
    "                    <div class=\"input\">\n" +
    "                        <input type=\"text\" id=\"address\" name=\"address\" ng-disabled=\"home.blockUx || home.lockAddress\"\n" +
    "                               ng-attr-placeholder=\"{{'Bitcoin address'|translate}}\" ng-model=\"transfer._address\" valid-address\n" +
    "                               required ng-focus=\"home.formFocus('address')\" ng-blur=\"home.formFocus(false)\">\n" +
    "                    </div>\n" +
    "                </div>\n" +
    "\n" +
    "                <div class=\"row\" ng-hide=\"home.hideAmount\">\n" +
    "                    <div class=\"large-12 medium-12 columns\">\n" +
    "                        <div class=\"right\" ng-hide=\"assetTransferForm.amount.$pristine && !assetTransferForm.amount.$modelValue \">\n" +
    "                            <span class=\"has-error right size-12\" ng-if=\"assetTransferForm.amount.$invalid\">\n" +
    "                                <i class=\"icon-close-circle size-14\"></i>\n" +
    "                                <span clas=\"vm\" translate>Not valid</span>\n" +
    "                            </span>\n" +
    "                            <small class=\"text-primary right\" ng-if=\"!assetTransferForm.amount.$invalid\">\n" +
    "                                <i class=\"icon-checkmark-circle size-14\"></i>\n" +
    "                            </small>\n" +
    "                        </div>\n" +
    "                        <div>\n" +
    "                            <label for=\"amount\">\n" +
    "                                <span translate>Amount</span>\n" +
    "                            </label>\n" +
    "\n" +
    "                            <div class=\"input\">\n" +
    "                                <input type=\"number\" id=\"amount\" ng-disabled=\"home.blockUx || home.lockAmount\"\n" +
    "                                       name=\"amount\" ng-attr-placeholder=\"{{'Amount'|translate}}\"\n" +
    "                                       ng-minlength=\"0.00000001\" ng-maxlength=\"10000000000\" ng-model=\"transfer._amount\"\n" +
    "                                       valid-amount required autocomplete=\"off\" ng-focus=\"home.formFocus('amount')\"\n" +
    "                                       ng-blur=\"home.formFocus(false)\">\n" +
    "                                <a class=\"postfix\" translate>units</a>\n" +
    "                            </div>\n" +
    "                        </div>\n" +
    "                        <div>\n" +
    "                            <label for=\"fee\">\n" +
    "                                <span translate>Fee</span>\n" +
    "                            </label>\n" +
    "\n" +
    "                            <div class=\"input\">\n" +
    "                                <input type=\"number\" id=\"fee\" ng-model=\"fee\" disabled>\n" +
    "                                <a class=\"postfix\" translate>bits</a>\n" +
    "                            </div>\n" +
    "                        </div>\n" +
    "\n" +
    "                    </div>\n" +
    "                </div>\n" +
    "                <div class=\"row\" ng-show=\"!home.onGoingProcess\">\n" +
    "                    <div class=\"large-6 medium-6 small-6 columns\"\n" +
    "                             ng-show=\"!home.blockUx && (home.lockAddress || home.lockAmount)\">\n" +
    "                        <a ng-click=\"cancel()\" class=\"button expand outline dark-gray round\" translate>Cancel</a>\n" +
    "                    </div>\n" +
    "                    <div class=\"columns\"\n" +
    "                         ng-class=\"{'small-6 medium-6 large-6':(home.lockAddress || home.lockAmount)}\">\n" +
    "                        <button type=\"submit\" class=\"button black round expand\"\n" +
    "                                ng-disabled=\"assetTransferForm.$invalid || home.blockUx ||  index.isOffline\"\n" +
    "                                ng-style=\"{'background-color':index.backgroundColor}\" translate>\n" +
    "                            Transfer\n" +
    "                        </button>\n" +
    "                    </div>\n" +
    "\n" +
    "                </div>\n" +
    "            </form>\n" +
    "        </div>\n" +
    "    </div>\n" +
    "    <div class=\"extra-margin-bottom\"></div>\n" +
    "</div> <!-- END Send -->");
}]);
