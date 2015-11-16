'use strict';


angular.module('copayAddon.coloredCoins').service('colu', function (profileService, $rootScope, feeService, $log, $q) {

  var root = {},
      COLU_API_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiI3cjBnZ3lAZ21haWwuY29tIiwiZXhwIjoiMjAxNS0xMS0wOVQwMTozMToxMC45MzNaIiwidHlwZSI6ImFwaV9rZXkifQ.VnT2HH2rl1DBJQ3rwZRjh1vPhNoNjesYfAg07yq0OU8';

  var coluPromise = function(network) {
    return $q(function(resolve, reject) {
      var colu = new Colu({
        network: network,
        apiKey: network == 'livenet' ? COLU_API_KEY : undefined
      });
      colu.on('connect', function () {
        resolve(colu);
      });
      colu.init();
    });
  };

  var colu = {
    testnet: coluPromise('testnet'),
    livenet: coluPromise('livenet')
  };

  var withColu = function(func) {
    var network = profileService.focusedClient.credentials.network;
    colu[network].then(func);
  };

  $rootScope.$on('ColoredCoins/BroadcastTxp', function(e, txp) {
    root.broadcastTx(txp.raw, txp.customData.financeTxId, function (err, body) {
      if (err) {
        return $rootScope.$emit('ColoredCoins/Broadcast:error', "Colu returns error");
      }

      $rootScope.$emit('ColoredCoins/Broadcast:success');
    });
  });

  root.broadcastTx = function(signedTxHex, lastTxId, cb) {
    withColu(function(colu) {
      $log.debug('Broadcasting tx via Colu: ' + JSON.stringify({
        last_txid: lastTxId,
        tx_hex: signedTxHex
      }));
      colu.transmit(signedTxHex, lastTxId, cb);
    });
  };

  root.getAssetMetadata = function(asset, cb) {
    withColu(function(colu) {
      colu.coloredCoins.getAssetMetadata(asset.assetId, asset.utxo.txid + ":" + asset.utxo.index, cb);
    });
  };

  root.getAddressInfo = function(address, cb) {
    withColu(function(colu) {
      colu.coloredCoins.getAddressInfo(address, cb);
    });
  };

  root.issueAsset = function(args, cb) {
    withColu(function(colu) {
      $log.debug("Issuing asset via Colu: " + JSON.stringify(args));
      colu.issueAsset(args, function(err, body) {
        $log.debug("Colu returned tx: " + JSON.stringify(body));
        return cb(err, body);
      });
    });

  };

  root.createTx = function(fromAddress, type, args, cb) {
    withColu(function(colu) {
      $log.debug("Creating " + type + " asset tx via Colu: " + JSON.stringify(args));
      colu.buildTransaction(fromAddress, type, args, function(err, body) {
        $log.debug("Colu returned tx: " + JSON.stringify(body));
        return cb(err, body);
      });
    });
  };

  return root;

});
