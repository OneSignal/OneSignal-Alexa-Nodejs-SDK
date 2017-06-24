/**
 * Modified MIT License
 *
 * Copyright 2017 OneSignal
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * 1. The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * 2. All copies of substantial portions of the Software may only be used in connection
 * with services provided by OneSignal.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

var https = require('https');

const VERSION =  '000900';
const API_HOST =  'onesignal.com';
const ONE_DAY_SECONDS = 86400;
const ALEXA_DEVICE_TYPE = 10;

const API_BASE_PATH =  '/api/v1/';
const API_DEFAULT_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
};

var OneSignal = {
  // attributes that are saved and read from the DB.
  _scope_attributes: null,

  _appId: null,
  _userId: null,

  _pendingTags: null,

  init: function (app_id, alexa, event) {
    OneSignal._appId = app_id;
    alexa.registerHandlers(OneSignal._alexaHandlers);
  },

  // Alexa Skill event handlers
  _alexaHandlers: {
   // Messaging.MessageReceived':
    Unhandled: function() {
      OneSignal._stateSetup(this);
      OneSignal._processMessageReceived(this.event);
    },
    LaunchRequest: function () {
      OneSignal._stateSetup(this);
      OneSignal._newSession(this);
    }
  },

  _stateSetup: function(mainScope) {
    OneSignal._scope_attributes = mainScope.attributes['onesignal_sdk'];

    if (typeof OneSignal._scope_attributes == 'undefined') {
      OneSignal._scope_attributes = {};
    } else {
      if (OneSignal._scope_attributes.userId !== undefined)
        OneSignal._userId = OneSignal._scope_attributes.userId;
    }
  },

  _userPut: function(payload, error_string) {
    var options = {
      host: API_HOST,
      path: API_BASE_PATH + 'players/' + OneSignal._userId,
      method: 'PUT',
      headers: API_DEFAULT_HEADERS
    };

    var req = https.request(options, function(res) {
      res.on('data', function(data) {
      });
    });

    req.on('error', function(e) {
      console.log('OneSignal - ' + error_string + ' ERROR:');
      console.log(e);
    });

    req.write(JSON.stringify(payload));
    req.end();
  },

  sendTags: function(tags) {
    if (OneSignal._userId == null) {
       if (OneSignal._pendingTags == null) {
         OneSignal._pendingTags = {};
       }
       Object.assign(OneSignal._pendingTags, tags);
       return;
    }

    OneSignal._pendingTags = null;
    OneSignal._userPut({tags: tags}, 'sendTags');
  },

  _registerDevice: function(data, mainScope, callback) {
    var url_path = API_BASE_PATH + 'players';

    if (OneSignal._userId != null) {
       url_path += '/' + OneSignal._userId + '/on_session';
    }

    var options = {
      host: API_HOST,
      path: url_path,
      method: 'POST',
      headers: API_DEFAULT_HEADERS
    };

    if (OneSignal._pendingTags != null) {
      data.tags = OneSignal._pendingTags;
      OneSignal._pendingTags = null;
    }

    var req = https.request(options, function(res) {
      res.on('data', function(data) {
        var data = JSON.parse(data);
        if (typeof data.id != 'undefined') {
           OneSignal._userId = data.id;

           if (OneSignal._pendingTags == null) {
             OneSignal.sendTags(OneSignal._pendingTags);
           }

           OneSignal._scope_attributes.userId = OneSignal._userId;
           mainScope.attributes['onesignal_sdk'] = OneSignal._scope_attributes;
           mainScope.emit(':saveState', true);
        }
      });
    });

    req.on('error', function(e) {
      console.log('OneSignal - Register device ERROR:');
      console.log(e);
    });

    req.write(JSON.stringify(data));
    req.end();
  },

  _newSession: function(mainScope) {
    var event = mainScope.event;
    if (!event.session.new) {
      return;
    }

    var devicePayload = {
       app_id: OneSignal._appId,
       device_type: ALEXA_DEVICE_TYPE,
       sdk: OneSignal._VERSION,
       notification_types: OneSignal.hasNotificationPermissions(event) ? 1 : 0,
       identifier: event.context.System.user.userId
     };

     OneSignal._registerDevice(devicePayload, mainScope);
  },

  promptForNotificationPermissions: function(mainScope) {
    mainScope.handler.response = {
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'PlainText',
          text: 'Please open the Alexa App and accept the notification permissin card.'
        },
        card: {
          type: 'AskForPermissionsConsent',
          permissions: ['write::alexa:devices:all:notifications:standard']
        }
      }
    };
    mainScope.emit(':responseReady');
  },

  hasNotificationPermissions : function(event) {
    var permissions = event.context.System.user.permissions;
    return typeof permissions != 'undefined' && typeof permissions.consentToken != 'undefined';
  },

  _processMessageReceived: function(event) {
    if (event.request.type != 'Messaging.MessageReceived') {
      return;
    }

    if (!OneSignal.hasNotificationPermissions(event)) {
      if (OneSignal._userId != null) {
        OneSignal._userPut({notification_types: 0}, 'unsubscribing');
      }
      return;
    }

    var expiryTime = new Date();

    if (event.request.message.ttl === undefined) {
      expiryTime.setHours(expiryTime.getHours() + 24);
    } else {
      // Ensure we are not going over the 24 hour max limit.
      var secOffset = event.request.message.ttl;
      if (secOffset> ONE_DAY_SECONDS) {
        secOffset = ONE_DAY_SECONDS;
      }

      expiryTime.setSeconds(expiryTime.getSeconds() + secOffset);
    }

    var display_title = event.request.message.display_title;
    if (typeof display_title == 'undefined') {
      display_title = event.request.message.spoken_text;
    }

    OneSignal._createNotification(event.context.System.user.permissions.consentToken, {
      expiryTime: expiryTime.toISOString(),
      referenceId: event.request.message.custom.i,
      spokenInfo: {
        content:[{
          locale: 'en-US',
          text: event.request.message.spoken_text
          // ssml: '<speak>Overrides text</speak>'
        }]
      },
      displayInfo:{
        content:[{
          locale: 'en-US',
          toast: {
            primaryText: event.request.message.spoken_text
          },
          title: display_title,
          bodyItems:[{ primaryText: event.request.message.spoken_text}]
        }]
      }
    });
  },

  _createNotification: function(token, data) {
    var options = {
      host: 'api.amazonalexa.com',
      path: '/v2/notifications',
      method: 'POST',
      headers: Object.assign({
        Authorization: 'Bearer ' + token
      }, API_DEFAULT_HEADERS)
    };

    var req = https.request(options, function(res) {
      res.on('data', function(data) {
      });
    });

    req.on('error', function(e) {
      console.log('OneSignal - Error sending create notification:');
      console.log(e);
    });

    req.write(JSON.stringify(data));
    req.end();
  }
};

module.exports = OneSignal;
