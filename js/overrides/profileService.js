'use strict';

angular.module('copayAddon.coloredCoins').config(function ($provide) {

  $provide.decorator('profileService', function ($delegate, $rootScope) {
    var defaultSetWalletClient = $delegate.setWalletClient;

    $delegate.setWalletClient = function (credentials) {
      defaultSetWalletClient(credentials);
      var client = $delegate.walletClients[credentials.walletId];

      if (!client) return;

      var defaultBroadcastTxProposal = client.broadcastTxProposal;

      client.broadcastTxProposal = function (txp, cb) {
        if (txp.customData && txp.customData.financeTxId) {
          $rootScope.$on('ColoredCoins/Broadcast:success', function() {
            defaultBroadcastTxProposal(txp, cb);
          });
          $rootScope.$on('ColoredCoins/Broadcast:error', function(e, err) {
            cb(err);
          });

          $rootScope.$emit('ColoredCoins/BroadcastTxp', txp);
        } else {
          defaultBroadcastTxProposal(txp, cb);
        }
      };

      return client;
    };
    return $delegate;
  });
});