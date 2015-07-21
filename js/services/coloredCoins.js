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
    var coloredUtxos = lodash.map(assets, function(a) { return a.asset.utxo.txid + ":" + a.asset.utxo.index; });

    return lodash.reject(utxos, function(utxo) {
      return lodash.includes(coloredUtxos, utxo.txid + ":" + utxo.vout);
    });
  };

  var selectFinanceOutput = function(fee, fc, assets, cb) {
    fc.getUtxos(function(err, utxos) {
      if (err) { return cb(err); }

      var colorlessUtxos = root._rejectColoredUtxos(utxos, assets);

      for (var i = 0; i < colorlessUtxos.length; i++) {
        if (colorlessUtxos[i].satoshis >= fee) {
          return cb(null, colorlessUtxos[i]);
        }
      }
      return cb({ error: "Insufficient funds for fee" });
    });
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

  root.createTransferTx = function(asset, amount, toAddress, assets, cb) {
    if (amount > asset.amount) {
      return cb({ error: "Cannot transfer more assets then available" }, null);
    }

    var fc = profileService.focusedClient;

    var to = [{
      "address": toAddress,
      "amount": amount,
      "assetId": asset.asset.assetId
    }];

    // transfer the rest of asset back to our address
    if (amount < asset.asset.amount) {
      to.push({
        "address": asset.address,
        "amount": asset.asset.amount - amount,
        "assetId": asset.asset.assetId
      });
    }

    var fee = root.defaultFee();

    selectFinanceOutput(fee, fc, assets, function(err, financeUtxo) {
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
        from: asset.address,
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
