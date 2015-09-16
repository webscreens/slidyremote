/**
 * @fileOverview Shim for the latest version of the Presentation API [1] that
 * aims to support projecting to Chromecast devices, to attached devices (HDMI,
 * Miracast, etc.) through the experimental Chromium build [2] and to a separate
 * browser window as a fallback.
 *
 * Support for Chromecast devices is heavily restrained because Cast receiver
 * applications need to be registered with Google before they may be used and
 * this code needs to know about the mapping between the URL of the application
 * and the application ID provided by Google upon registration.
 *
 * As such, applications that want to make use of the shim on Google Cast
 * devices need first to issue a call to:
 *  navigator.presentation.registerCastApplication(appUrl, appId)
 *
 * Other restrictions:
 * - the code uses Promises, underlying Web browser needs to support them
 * - support for custom events is fairly limited. Only the "on" properties
 * are supported to attach to events on exposed objects, no way to use
 * "addEventListener" for the time being.
 * - The Cast sender library [3] needs to be loaded before that code if one
 * wants to support Chromecast devices.
 * - the code does not properly handle cases where the receiver calls
 *  "connection.close()".
 *
 * The code below is divided in 4 parts:
 *  a) a few helper functions and the definition of base classes to be used
 *     by the different presentation mechanisms that are supported
 *  b) the definition of the CastPresentationMechanism class that allows the
 *     polyfill to interact with Chromecast devices through the Chrome extension
 *  c) the definition of the WindowPresentationMechanism class that allows the
 *     polyfill to create presentations in a new window
 *  d) the actual definition of "navigator.presentation" and of the other
 *     related classes
 * The different interfaces could be moved to their own JS file, modules are
 * not used here not to have to introduce dependencies to some module loader
 * library.
 *
 * References:
 * [1] http://webscreens.github.io/presentation-api/
 * [2] http://webscreens.github.io/demo/#binaries
 * [3] https://www.gstatic.com/cv/js/sender/v1/cast_sender.js
 */
(function () {
  /**********************************************************************
  Simple console logger to help with debugging. Caller may change logging
  level by setting navigator.presentationLogLevel to one of "log", "info",
  "warn", "error" or "none" (or null which also means "none").

  Note this should be done before that shim is loaded!
  **********************************************************************/
  var log = function () {
    var presentationLogLevel = navigator.presentationLogLevel || 'none';
    if ((presentationLogLevel === 'none') || (arguments.length === 0)) {
      return;
    }

    var level = arguments[0];
    var params = null;
    if ((level === 'log') ||
        (level === 'info') ||
        (level === 'warn') ||
        (level === 'error')) {
      // First parameter is the log level
      params = Array.prototype.slice.call(arguments, 1);
    }
    else {
      // No log level provided, assume "log"
      level = 'log';
      params = Array.prototype.slice.call(arguments);
    }
    if ((level === 'error') ||
        ((level === 'warn') &&
          (presentationLogLevel !== 'error')) ||
        ((level === 'info') &&
          (presentationLogLevel !== 'error') &&
          (presentationLogLevel !== 'warn')) ||
        ((level === 'log') &&
          (presentationLogLevel === 'log'))) {
      console[level].apply(console, params);
    }
  };


  /**********************************************************************
  Short helper function to "queue a task"
  **********************************************************************/
  var queueTask = function (task) {
    setTimeout(task, 0);
  };


  /**********************************************************************
  Shim for DOMExceptions (cannot be instantiated in most browsers for
  the time being)
  **********************************************************************/
  var _DOMException = function (name, message) {
    this.name = name;
    this.message = message;
  };




  /**********************************************************************
  Global sets of objects that the User Agent must keep track of
  **********************************************************************/
  /**
   * The list of presentation API mechanisms that may be used to connect
   * to a second screen
   *
   * @type {Array(PresentationMechanism)}
   */
  var registeredMechanisms = [];


  /**
   * Register a new presentation API mechanism
   *
   * @function
   * @private
   * @param {PresentationMechanism} mechanism The mechanism to register
   */
  var registerPresentationMechanism = function (mechanism) {
    registeredMechanisms.push(mechanism);
  };




  /**********************************************************************
  BrowsingContext internal interface
  **********************************************************************/

  /**
   * A remote browsing context with which one can exchange messages
   *
   * This base class is an empty shell
   *
   * Presentation mechanisms that expose browsing contexts must inherit
   * from this base class.
   *
   * @constructor
   * @private
   * @param {String} name A human-friendly name to identify the context
   */
  var BrowsingContext = function (name) {
    /**
     * A human-friendly name for the browsing context
     *
     * @type {String}
     */
    this.name = name;


    /**
     * The current connection state
     *
     * @type {String}
     */
    this.state = 'disconnected';


    /**
     * Open a data communication channel with the browsing context
     *
     * @function
     * @return {Promise} The promise to have a data communication channel
     * ready to be used for exchanging messaging with the browsing context
     */
    this.open = function () {
      return new Promise(function (resolve, reject) {
        resolve();
      });
    };


    /**
     * Sends a message through the communication channel.
     *
     * @function
     * @param {*} message
     */
    this.send = function (message) {
      throw new _DOMException('InvalidStateError');
    };


    /**
     * Event handler called when a message is received on the communication
     * channel.
     *
     * @type {EventHandler}
     */
    this.onmessage = null;


    /**
     * Close the communication channel
     *
     * @function
     */
    this.close = function () {};
  };




  /**********************************************************************
  ReceivingBrowsingContext internal interface
  **********************************************************************/

  /**
   * A remote receiving browsing context is a remote browsing context that may
   * be navigated to a given URL.
   *
   * @constructor
   * @private
   * @param {String} name A human-friendly name to identify the context
   */
  var ReceivingBrowsingContext = function (name) {
    BrowsingContext.call(this, name);

    /**
     * Navigate the browsing context to the given URL
     *
     * @function
     * @param {String} url The URL to navigate to
     * @return {Promise} The promise to have navigated to the given URL. The
     * promise is rejected with a DOMException named "OperationError"
     */
    this.navigate = function (url) {
      return new Promise(function (resolve, reject) {
        reject(new _DOMException('OperationError'));
      });
    };
  };




  /**********************************************************************
  PresentationMechanism internal interface
  **********************************************************************/

  /**
   * Exposes a mechanism to detect, connect and control a second screen
   *
   * Concrete mechanisms must inherit from this base class.
   *
   * @constructor
   * @private
   */
  var PresentationMechanism = function () {
    /**
     * Some friendly name for the mechanism, mostly for logging purpose
     *
     * To be set in derivated classes.
     *
     * @type {String}
     */
    this.name = 'default presentation mechanism';


    /**
     * Compute the list of available presentation displays that the user may
     * select to launch a presentation.
     *
     * Internally, these "displays" are represented as receiving browsing
     * contexts.
     *
     * @function
     * @return {Promise<Array(ReceivingBrowsingContext)} The promise to get the
     * current list of available presentation displays
     */
    this.getAvailableDisplays = function () {
      return new Promise(function (resolve, reject) {
        resolve();
      });
    };


    /**
     * Start to monitor incoming presentation connections if code runs on the
     * receiving side.
     *
     * The function should not do anything if the code is not running on the
     * receiving side.
     *
     * @function
     */
    this.monitorIncomingContexts = function () {
      queueTask(function () {
      });
    };


    /**
     * Event handler called when an incoming browsing context is detected
     *
     * The "context" attribute of the event that is given to the handler is set
     * to the presentation context that connected to this browsing context
     *
     * @type {EventHandler}
     */
    this.onincomingcontext = null; 
  };




  /**********************************************************************
  CastPresentationMechanism
  **********************************************************************/
  /**
   * The cast presentation mechanism allows a user to request display of
   * Web content on available Google Cast devices discovered through the
   * Cast extension.
   *
   * The extension does not expose the list of Chromecast devices that
   * are available, so this mechanism takes for granted that there is
   * one.
   *
   * Note that the mechanism also exposes the "registerCastApplication"
   * static function to register the mapping between a receiver app URL
   * and its Google Cast ID
   *
   * @constructor
   * @inherits {PresentationMechanism}
   */
  var CastPresentationMechanism = (function () {
    /**
     * Whether the Cast API library is available or not.
     * If it's not, the Promises returned by "create" and "startReceiver"
     * will always end up being rejected.
     */
    var castApiAvailable = false;
    window['__onGCastApiAvailable'] = function (loaded, errorInfo) {
      if (loaded) {
        log('Google Cast API library is available and loaded');
        castApiAvailable = true;
      } else {
        log('warn',
          'Google Cast API library is available but could not be loaded',
          errorInfo);
      }
    };


    /**
     * Whether the Cast API library has been initialized.
     *
     * That flag is used to support multiple calls to "requestSession". Once
     * the Cast API library has been initialized, subsequent Cast session
     * requests should directly call sessionRequest.
     */
    var castApiInitialized = false;


    /**
     * Mapping table between receiver application URLs and Cast application IDs
     *
     * Ideally, there should not be any need to maintain such a mapping table
     * but there is no way to have an arbitrary URL run on a Chromecast device.
     */
    var castApplications = {};


    var CastBrowsingContext = function (name, castReceiverManager) {
      BrowsingContext.call(this, name);
      this.state = 'connected';

      var that = this;
      var customMessageBus = castReceiverManager.getCastMessageBus(
        'urn:x-cast:org.w3c.webscreens.presentationapi.shim',
        cast.receiver.CastMessageBus.MessageType.JSON);
      customMessageBus.addEventListener('message', function (event) {
        log('received message from Cast sender', event.data);
        if (that.onmessage) {
          that.onmessage(event);
        }
      });

      this.send = function (message) {
        if (that.state !== 'connected') {
          return;
        }
        log('send message to Cast sender', message);
        customMessageBus.broadcast(message);
      };

      this.close = function () {
        if (that.state !== 'connected') {
          return;
        }
        log('stop Cast receiver manager');
        castReceiverManager.stop();
        that.state = 'disconnected';
        if (that.onstatechange) {
          that.onstatechange();
        }
      }
    };


    var CastReceivingBrowsingContext = function (name) {
      ReceivingBrowsingContext.call(this, name);
      this.state = 'disconnected';

      var castSession = null;
      var that = this;

      this.navigate = function (url) {
        return new Promise(function (resolve, reject) {
          if (!castApiAvailable) {
            log('cannot create Cast session',
              'Google Cast API library is not available');
            reject(new _DOMException('OperationError'));
            return;
          }

          if (!castApplications[url]) {
            log('cannot create Cast session',
              'no receiver app known for url', url);
            reject(new _DOMException('OperationError'));
            return;
          }

          var applicationId = castApplications[url];
          var sessionRequest = new chrome.cast.SessionRequest(applicationId);

          var requestSession = function () {
            log('request new Cast session for url', url);
            chrome.cast.requestSession(function (session) {
              log('got a new Cast session');
              castSession = session;
              resolve();
            }, function (error) {
              if (castSession) {
                return;
              }
              if (error.code === 'cancel') {
                log('info', 'user chose not to use Cast device');
              }
              else if (error.code === 'receiver_unavailable') {
                log('info', 'no compatible Cast device found');
              }
              else {
                log('error', 'could not create Cast session', error);
              }
              reject(new _DOMException('OperationError'));
            }, sessionRequest);
          };

          var apiConfig = new chrome.cast.ApiConfig(
            sessionRequest,
            function sessionListener(session) {
              // Method called at most once after initialization if a running
              // Cast session may be resumed
              log('found existing Cast session, reusing');
              castSession = session;
              resolve();
            },
            function receiverListener(available) {
              // Method called whenever the number of Cast devices available in
              // the local network changes. The method is called at least once
              // after initialization. We're interested in that first call.
              if (castSession) {
                return;
              }

              // Reject creation if there are no Google Cast devices that
              // can handle the application.
              if (available !== chrome.cast.ReceiverAvailability.AVAILABLE) {
                log('cannot create Cast session',
                  'no Cast device available for url', url);
                reject(new _DOMException('OperationError'));
              }

              log('found at least one compatible Cast device');
              requestSession();
            });

          if (castApiInitialized) {
            // The Cast API library has already been initialized, call
            // requestSession directly.
            log('Google Cast API library already initialized',
              'request new Cast session');
            requestSession();
          }
          else {
            // The Cast API library first needs to be initialized
            log('initialize Google Cast API library for url', url);
            chrome.cast.initialize(apiConfig, function () {
              // Note actual session creation is handled by callback functions
              // defined above
              log('Google Cast API library initialized');
              castApiInitialized = true;
            }, function (err) {
              log('error',
                'Google Cast API library could not be initialized', err);
              reject();
              return;
            });
          }
        });
      };


      this.open = function () {
        return new Promise(function (resolve, reject) {
          if (!castSession) {
            reject();
            return;
          }
          if (that.state === 'connected') {
            resolve();
            return;
          }

          castSession.addUpdateListener(function (isAlive) {
            that.state = isAlive ? 'connected' : 'disconnected';
            log('received Cast session state update', 'isAlive=' + isAlive);
            if (that.onstatechange) {
              that.onstatechange();
            }
          });

          var namespace = castSession.namespaces[0];
          castSession.addMessageListener(namespace.name, function (namespace, message) {
            log('received message from Cast receiver', message);
            if (that.onmessage) {
              that.onmessage({ data: message });
            }
          });

          that.state = 'connected';
          if (that.onstatechange) {
            that.onstatechange();
          }
          resolve();
        });
      };


      this.send = function (message) {
        if (that.state !== 'connected') {
          return;
        }
        log('send message to Cast receiver', message);
        var namespace = castSession.namespaces[0];
        castSession.sendMessage(namespace.name, message);
      };


      this.close = function () {
        if (that.state !== 'connected') {
          return;
        }
        log('close Cast session');
        castSession.stop();
        that.state = 'disconnected';
        if (that.onstatechange) {
          that.onstatechange();
        }
      };
    };


    /**
     * The actual presentation mechanism based on the Chrome Cast extension
     */
    var CastPresentationMechanism = function () {
      PresentationMechanism.call(this);
      this.name = 'cast presentation mechanism';

      var that = this;

      this.getAvailableDisplays = function () {
        return new Promise(function (resolve, reject) {
          var display = new CastReceivingBrowsingContext('A chromecast device');
          resolve([display]);
        });
      };

      this.monitorIncomingContexts = function () {
        // Detect whether the code is running on a Google Cast device. If it is,
        // it means the code is used within a Receiver application and was
        // launched as the result of a call to:
        //   navigator.presentation.requestSession
        // NB: no better way to tell whether we're running on a Cast device
        // for the time being, see:
        // https://code.google.com/p/google-cast-sdk/issues/detail?id=157
        var runningOnChromecast = !!window.navigator.userAgent.match(/CrKey/);
        if (!runningOnChromecast) {
          log('code is not running on a Google Cast device');
          return;
        }

        // Start the Google Cast receiver
        // Note the need to create the CastReceiverSession before the call to
        // "start", as that class registers the namespace used for the
        // communication channel.
        log('code is running on a Google Cast device',
          'start Google Cast receiver manager');
        var castReceiverManager = cast.receiver.CastReceiverManager.getInstance();
        var context = new CastBrowsingContext('controlling Cast extension', castReceiverManager);
        castReceiverManager.start();
        castReceiverManager.onReady = function () {
          log('Google Cast receiver manager started');
          if (that.onincomingcontext) {
            that.onincomingcontext(context);
          }
        };
      };
    };


    /**
     * Registers the equivalence between the URL of a receiver application and
     * its Google Cast app ID.
     *
     * @function
     * @static
     * @param {String} url URL of the receiver application
     * @param {String} id The Cast application ID associated with that URL
     */
    CastPresentationMechanism.registerCastApplication = function (url, id) {
      castApplications[url] = id;
    };
    

    // Expose the presentation mechanism to the external world
    return CastPresentationMechanism;
  })();






  /**********************************************************************
  WindowPresentationMechanism
  **********************************************************************/

  /**
   * The window presentation mechanism allows a user to open a new window on
   * the same screen and pretend that it is a second screen.
   *
   * @constructor
   * @inherits {PresentationMechanism}
   */
  var WindowPresentationMechanism = (function () {
    /**
     * Remote window controlling browsing context
     *
     * @constructor
     * @private
     * @param {String} name Human-friendly name for that display
     * @param {Window} source Reference to the controlling window
     */
    var WindowBrowsingContext = function (name, source) {
      BrowsingContext.call(this, name);
      this.state = 'connected';

      var that = this;
      this.send = function (message) {
        if (that.state !== 'connected') {
          throw new _DOMException('InvalidStateError');
        }
        log('send message to receiving window', message);
        source.postMessage(message, '*');
      };

      window.addEventListener('message', function (event) {
        if (event.source === source) {
          if (that.onmessage) {
            that.onmessage(event);
          }
        }
      });
    };


    /**
     * Remote window receiving browsing context that may be navigated to
     * some URL
     *
     * @constructor
     * @private
     * @param {String} name Human-friendly name for that display
     */
    var WindowReceivingBrowsingContext = function (name) {
      ReceivingBrowsingContext.call(this, name);

      var receivingWindow = null;
      var openPromise = null;
      var openPromiseResolve = null;
      var openPromiseReject = null;
      var reconnectionNeeded = false;
      var that = this;

      this.navigate = function (url) {
        return new Promise(function (resolve, reject) {
          receivingWindow = window.open(url, name);
          if (!receivingWindow) {
            log('could not open receiving window');
            reject(new _DOMException('OperationError'));
            return;
          }
          window.addEventListener('message', function (event) {
            if (that.state === 'disconnected') {
              if ((event.source === receivingWindow) &&
                  (event.data === 'ispresentation')) {
                log('received "is this a presentation connection?" message ' +
                  'from receiving window');
                log('send "presentation" message to receiving window');
                receivingWindow.postMessage('presentation', '*');
              }
              else if ((event.source === receivingWindow) &&
                  (event.data === 'presentationready')) {
                log('received "presentation ready" message ' +
                  'from receiving window');
                that.state = 'connected';
                if (openPromiseResolve) {
                  openPromiseResolve();
                  openPromiseResolve = null;
                  openPromiseReject = null;
                }
                if (that.onstatechange) {
                  queueTask(function () {
                    that.onstatechange();
                  });
                }
              }
            }
            else {
              if ((event.source === receivingWindow) &&
                  (event.data === 'receivershutdown')) {
                log('received shut down message from receiving side', 'disconnect');
                that.state = 'disconnected';
                reconnectionNeeded = true;
                if (openPromiseReject) {
                  openPromiseReject();
                  openPromiseResolve = null;
                  openPromiseReject = null;
                }
                if (that.onstatechange) {
                  queueTask(function () {
                    that.onstatechange();
                  });
                }
              }
              else {
                log('received message from receiving window', event.data);
                if (that.onmessage) {
                  that.onmessage(event);
                }
              }
            }
          }, false);
          resolve();
        });
      };

      this.open = function () {
        if (openPromise) {
          return openPromise;
        }
        openPromise = new Promise(function (resolve, reject) {
          if (that.state === 'connected') {
            resolve();
          }
          else {
            openPromiseResolve = resolve;
          }
        });
        return openPromise;
      };

      this.send = function (message) {
        if (that.state !== 'connected') {
          throw new _DOMException('InvalidStateError');
        }
        log('send message to receiving window', message);
        receivingWindow.postMessage(message, '*');
      };

      this.close = function () {
        if (that.state !== 'connected') {
          return;
        }
        log('close presentation window');
        receivingWindow.close();
        that.state = 'disconnected';
        queueTask(function () {
          if (that.onstatechange) {
            that.onstatechange();
          }
        });
      };
    };


    var WindowPresentationMechanism = function () {
      PresentationMechanism.call(this);
      this.name = 'window presentation mechanism';

      var controllingWindows = [];
      var that = this;

      this.getAvailableDisplays = function () {
        return new Promise(function (resolve, reject) {
          var display = new WindowReceivingBrowsingContext('A beautiful window on your screen');
          resolve([display]);
        });
      };

      this.monitorIncomingContexts = function () {
        // No window opener? The code does not run a receiver app.
        if (!window.opener) {
          log('code is not running in a receiving window');
          return;
        }

        var messageEventListener = function (event) {
          // Note that the event source window is not checked to allow multiple
          // controlling windows
          var newContext = null;
          if (event.data === 'presentation') {
            log('received "presentation" message from some window');
            log('code is running in a receiving window');
            if (that.onincomingcontext &&
                !controllingWindows.some(function (win) {
                return (win === event.source);
              })) {
              controllingWindows.push(event.source);
              event.source.postMessage('presentationready', '*');
              var context = new WindowBrowsingContext(
                'controlling window',
                event.source);
              if (that.onincomingcontext) {
                that.onincomingcontext(context);
              }
            }
          }
        };

        window.addEventListener('message', messageEventListener, false);
        log('send "ispresentation" message to opener window ' +
          'and wait for "presentation" message');
        log('assume code is not running in a receiving window ' +
          'in the meantime');
        window.opener.postMessage('ispresentation', '*');
        window.addEventListener('unload', function () {
          log('receiving window is being closed');
          controllingWindows.forEach(function (win) {
            if (win) {
              win.postMessage('receivershutdown', '*');
            }
          });
        }, false);
      };
    };
    WindowPresentationMechanism.prototype = new PresentationMechanism();

    // Expose the presentation mechanism to the external world
    return WindowPresentationMechanism;
  })();




  /**********************************************************************
  PresentationConnection interface
  **********************************************************************/

  /**
   * Implements the PresentationConnection interface that is merely a wrapper
   * around a specified connection. 
   *
   * @constructor
   * @param {BrowsingContext} display The display with which the user is
   * effectively communicating. The display is represented internally as a
   * remote browsing context. On the controlling side, this remote browsing
   * context may be navigated to a given URL. On the receiving side, the
   * remote browsing context can only be used to exchange messages with the
   * other end.
   */
  var PresentationConnection = function (display) {
    /**
     * The presentation connection identifier
     *
     * @type {String}
     */
    this.id = null;

    /**
     * The current connection state
     *
     * @type {String}
     */
    this.state = 'disconnected';

    /**
     * Event handler called when connection state changes
     *
     * @type {EventHandler}
     */
    this.onstatechange = null;

    /**
     * Event handler called when a message is received on the communication
     * channel.
     *
     * @type {EventHandler}
     */
    this.onmessage = null;

    /**
     * The underlying display (remote browsing context)
     *
     * @type {BrowsingContext}
     */
    this.display = display;

    /**
     * Sends a message through the communication channel.
     *
     * @function
     * @param {*} message
     */
    this.send = function (message) {
      if (!display) {
        throw new _DOMException('InvalidStateError', 'Presentation connection not available, cannot send message');
      }
      if (this.state === 'disconnected') {
        throw new _DOMException('InvalidStateError', 'Presentation connection is disconnected, cannot send message');
      }
      display.send(message);
    };


    /**
     * Close the connection
     *
     * @function
     */
    this.close = function () {
      if (!display) {
        return;
      }
      display.close();
      display = null;
    };


    // Initialize bindings with underlying display/context
    var that = this;
    display.onstatechange = function () {
      that.state = display.state;
      if (that.onstatechange) {
        that.onstatechange();
      }
    };
    display.onmessage = function (message) {
      if (that.onmessage) {
        that.onmessage(message);
      }
    };
    if (this.state !== display.state) {
      this.state = display.state;
      if (this.onstatechange) {
        this.onstatechange();
      }
    }
  };




  /**********************************************************************
  PresentationAvailability interface
  **********************************************************************/

  /**
   * Information about the current results of the presentation display
   * availability monitoring.
   *
   * An instance of this class is returned by PresentationRequest's
   * getAvailability method if monitoring is supported by the user agent.
   *
   * Controlling app may listen to the "change" event to be notified about
   * availability changes.
   *
   * @constructor
   */
  var PresentationAvailability = function () {
    /**
     * Whether there are presentation displays available
     *
     * @type {boolean}
     */
    this.value = false;

    /**
     * Event handler called when availability flag changes
     *
     * @type {EventHandler}
     */
    this.onchange = null;
  };




  /**********************************************************************
  PresentationConnectionEvent interface
  **********************************************************************/

  /**
   * Event fired with a pointer to a presentation connection once a
   * presentation request is properly started.
   *
   * @constructor
   * @inherits {Event}
   * @param {connection:PresentationConnection} eventInitDict An object that
   * points to the presentation connection to associate with the event
   */
  var PresentationConnectionEvent = function (eventInitDict) {
    this.connection = eventInitDict.connection;
  };




  /**********************************************************************
  PresentationRequest interface
  **********************************************************************/

  /**
   * The PresentationRequest interface represents an intent to start a
   * presentation at a given URL.
   *
   * This shim implements both the controlling side and the receiving side.
   * However, note that this interface is useless on the receiving side.
   *
   * @constructor
   * @param {String} url The URL to present when the intent is to be started
   */
  var PresentationRequest = (function () {
    /**
     * The set of presentation connections known to the controlling context
     *
     * @private
     * @type {Array({url:String, id:String, connection:PresentationConnection})}
     */
    var setOfPresentations = [];


    /**
     * The set of availability objects requested through the getAvailability
     * method.
     *
     * @private
     * @type {Array({A:PresentationAvailability, availabilityUrl:String})}
     */
    var setOfAvailabilityObjects = [];


    /**
     * The set of available presentation displays
     *
     * @private
     * @type {Array(ReceivingBrowsingContext)}
     */
    var listOfAvailablePresentationDisplays = [];


    /**
     * Returns a new valid presentation connection identifier unique among
     * all those present in the set of presentations
     *
     * @function
     * @private
     * @return {String} unique presentation connection id
     */
    var getNewValidPresentationConnectionIdentifier = function () {
      return setOfPresentations.length;
    };


    /**
     * The actual PresentationRequest interface
     */
    var PresentationRequest = function (url) {
      /**
       * Fired when the presentation connection associated with the object is
       * created, following a call to start, reconnect or, for the default
       * presentation, when the UA creates it on the controller's behalf.
       *
       * @type {EventHandler}
       */
      this.onconnection = null;


      /**
       * Start a presentation connection
       *
       * This method will prompt the user to select a screen among discovered
       * screens.
       *
       * @function
       * @return {Promise<PresentationConnection>} The promise that a user-selected
       *   second screen will have navigated to the requested URL and that the user
       *   agent will try to establish a communication channel between the
       *   controlling and receiving applications.
       *   The promise is rejected when the user did not select any screen or
       *   because navigation to the URL failed.
       */
      this.start = function () {
        return isAllowedToShowPopup()
          .then(monitorAvailablePresentationDisplays)
          .then(function () {
            if (listOfAvailablePresentationDisplays.length === 0) {
              throw new _DOMException('NotFoundError');
            }
          })
          .then(requestUserToSelectPresentationDisplay)
          .then(navigateReceivingBrowserToPresentationUrl)
          .then(function (display) {
            var connection = createPresentationConnection(display);
            establishPresentationConnection(connection);
            return connection;
          });
      };


      /**
       * Reconnect to a presentation connection
       *
       * The presentation connection must be known to the underlying user agent. In
       * other words, there should have been a call to "start" performed on that
       * user agent at some point in the past for the exact same presentation
       * request URL.
       *
       * TODO: the polyfill could perhaps save the set of presentations using the
       * the local storage. This probably won't be enough to avoid permission
       * prompts though.
       * 
       * @function
       * @param {String} presentationId The identifier of the presentation 
       * @return {Promise<PresentationConnection>} The promise to have re-connected
       *   to the former presentation connection and that the user agent will try
       *   to re-establish a communication channel between the controlling and
       *   receiving applications.
       *   The promise is rejected if the given presentation identified is unknown.
       */
      this.reconnect = function (presentationId) {
        return new Promise(function (resolve, reject) {
          queueTask(function () {
            var connection = null;
            setOfPresentations.forEach(function (presentation) {
              if (connection) {
                return;
              }
              if ((presentation.url === url) &&
                  (presentation.id === presentationId)) {
                connection = presentation.connection;
              }
            });
            if (connection) {
              resolve(connection);
              establishPresentationConnection(connection);
            }
            else {
              reject(new _DOMException('NotFoundError'));
            }
          });
        });
      };


      /**
       * Request the user agent to monitor the list of available presentation
       * displays
       *
       * @function
       * @return {Promise<PresentationAvailability>} The promise to know whether
       *  presentation displays are available and be notified about evolutions.
       *  The promise is rejected if the user agent is unable to monitor available
       *  displays, either because the user denied it or because it does not
       *  support that feature.
       */
      this.getAvailability = function () {
        return new Promise(function (resolve, reject) {
          log('warn', 'getAvailability is not supported');
          reject(new _DOMException('NotSupportedError'));
        });
      };


      /**********************************************************************
      PresentationRequest - private properties and methods
      **********************************************************************/

      /**
       * A pointer to this object
       */
      var thisPresentationRequest = this;


      /**
       * Determine whether the algorithm is allowed to show a popup
       *
       * @function
       * @private
       * @return {Promise} A promise resolved if algorithm is allowed to show a
       * popup. Promise is rejected with a DOMException named
       * "InvalidAccessError" otherwise.
       */
      var isAllowedToShowPopup = function () {
        return new Promise(function (resolve, reject) {
          // 1. If the algorithm isn't allowed to show a popup, return a Promise
          // rejected with a DOMException named "InvalidAccessError" and abort
          // these steps.
          // TODO: can this be detected in JavaScript?
          resolve();
        });
      };


      /**
       * Monitor the list of presentation displays that are available and return
       * that list
       *
       * @function
       * @private
       * @return {Promise} The Promise that the list of presentation displays
       * will have been refreshed. The promise is never rejected.
       */
       var monitorAvailablePresentationDisplays = function () {
        return new Promise(function (resolve, reject) {
          queueTask(function () {
            log('get list of available displays from registered mechanisms');
            Promise.all(registeredMechanisms.map(function (mechanism) {
              return mechanism.getAvailableDisplays();
            })).then(function (lists) {
              // Flattten the lists of displays
              var newDisplays = lists.reduce(function (a, b) {
                return a.concat(b);
              });

              setOfAvailabilityObjects.forEach(function (availabilityObject) {
                var previousAvailability = availabilityObject.A.value;
                var newAvailability = newDisplays.some(function (display) {
                  log('warn', 'TODO: is display compatible with availabilityUrl?');
                  return true;
                });
                if (previousAvailability !== newAvailability) {
                  queueTask(function () {
                    availabilityObject.A.value = newAvailability;
                    if (availabilityObject.A.onchange) {
                      availabilityObject.A.onchange();
                    }
                  });
                }
              });
              listOfAvailablePresentationDisplays = newDisplays;
              resolve();
            });
          });
        });
      };


      /**
       * Request the user permission for the user of a presentation display and
       * selection of one presentation display
       *
       * @function
       * @private
       * @return {Promise} The promise to get the presentation display that the
       * user will have selected. The promise is rejected with a DOMException
       * named "AbortError" if the user does not select any display.
       */
      var requestUserToSelectPresentationDisplay = function () {
        return new Promise(function (resolve, reject) {
          var msg = 'Select a display:\n\n';
          var idx = 0;
          listOfAvailablePresentationDisplays.forEach(function (display) {
            idx += 1;
            msg += '[' + idx + '] ' + display.name + '\n';
          });
          var choice = window.prompt(msg, '1');
          var display = null;
          try {
            choice = parseInt(choice, 10);
            choice -= 1;
          }
          catch (e) {
            reject(new _DOMException('AbortError'));
            return;
          }
          display = listOfAvailablePresentationDisplays[choice];
          if (display) {
            resolve(display);
          }
          else {
            reject(new _DOMException('AbortError'));
          }
        });
      };


      /**
       * Create a new browsing context on the given display and navigate to
       * the requested URL
       *
       * @function
       * @private
       * @param {} display The user-selected display
       * @return {Promise} The promise that the display will have nagivated to
       * the requested URL. The promise is rejected with a DOMException named
       * "OperationError" if the presentation display cannot be navigated to the
       * requested URL.
       */ 
      var navigateReceivingBrowserToPresentationUrl = function (display) {
        return new Promise(function (resolve, reject) {
          queueTask(function () {
            log('navigate display to requested url');
            display.navigate(url).then(function () {
              resolve(display);
            }, reject);
          });
        });
      };


      /**
       * Create a presentation connection linked to the selected display
       *
       * Follows the relevant substeps of the "start a presentation connection"
       * algorithm.
       *
       * @function
       * @private
       * @return PresentationConnection A new presentation connection with a
       * valid connection id. The presentation connection is automatically
       * added to the set of presentations.
       */
      var createPresentationConnection = function (display) {
        var connection = new PresentationConnection(display);
        connection.id = getNewValidPresentationConnectionIdentifier();
        connection.state = 'disconnected';
        setOfPresentations.push({
          url: url,
          id: connection.id,
          connection: connection
        });
        return connection;
      };


      /**
       * Establish a presentation connection with the underlying display
       *
       * The method will queue a task to establish a presentation connection.
       * When successful, a statechange event is fired on the presentation
       * connection.
       *
       * @function
       * @private
       * @param {PresentationConnection} connection The connection that we want
       * to create a connection for
       */
      var establishPresentationConnection = function (connection) {
        // Queue a task to fire an event named "connection" at
        // presentationRequest with S as its connection attribute. 
        queueTask(function () {
          var connectEvent = new PresentationConnectionEvent({
            connection: connection
          });
          if (thisPresentationRequest.onconnection) {
            thisPresentationRequest.onconnection(connectEvent);
          }
        });

        if (connection.state === 'connected') {
          return;
        }

        queueTask(function () {
          connection.display.open().then(function () {
            queueTask(function () {
              setOfPresentations.forEach(function (presentation) {
                if ((connection !== presentation.connection) &&
                    (presentation.id === connection.id)) {
                  queueTask(function () {
                    if (presentation.connection.onstatechange) {
                      presentation.connection.onstatechange();
                    }
                  });
                }
              });
            });
          });
        });
      };
    };

    return PresentationRequest;
  })();




  /**********************************************************************
  PresentationReceiver interface
  **********************************************************************/

  /**
   * Implements the main interface for the receiving side.
   *
   * This shim implements both the controlling side and the receiving side.
   * However, note that this interface is useless on the controlling side.
   *
   * @constructor
   */
  var PresentationReceiver = function () {
    /**
     * Fired when a new incoming presentation connection is detected.
     * A call to "getConnections" will return the list of presentations.
     *
     * @type {EventHandler}
     */
    this.onconnection = null;


    /**
     * Retrieve the first connected presentation connection as it becomes
     * available
     *
     * The function waits indefinitely if not controlling browsing context
     * connects to this connection.
     *
     * @function
     * @return {Promise<PresentationConnection>} The promise that some controlling
     *   application has initiated connection to this app, perhaps as the result
     *   of calling PresentationRequest.start() and that the user agent will
     *   establish a communication channel between the controlling and receiving
     *   applications.
     *   The promise is never rejected but may hang indefinitely if no
     *   controlling application ever connects to this application.
     *   Note that the presentation connection that gets returned may be in a
     *   "disconnected" state if controlling side has disconnected in the
     *   meantime.
     */
    this.getConnection = function () {
      if (pendingPromise) {
        return pendingPromise;
      }
      else {
        pendingPromise = new Promise(function (resolve, reject) {
          queueTask(function () {
            if (setOfIncomingPresentations.length === 0) {
              pendingResolveFunction = resolve;
            }
            else {
              resolve(setOfIncomingPresentations[0].connection);
            };
          });
        });
        return pendingPromise;
      }
    };


    /**
     * Retrieve the list of connected connections
     *
     * @function
     * @return {Promise<[PresentationConnection]>} The promise to be given a list
     *   of presentation connections that are currently associated with this
     *   receiving application.
     */
    this.getConnections = function () {
      return new Promise(function (resolve, reject) {
        queueTask(function () {
          var connections = setOfIncomingPresentations.map(function (presentation) {
            return presentation.connection;
          });
          resolve(connections);
        });
      });
    };


    /**********************************************************************
    PresentationReceiver - private properties and methods
    **********************************************************************/
    var thisPresentationReceiver = this;

    /**
     * The set of incoming presentation connections
     *
     * @private
     * @type {Array({url:String, id:String, connection:PresentationConnection})}
     */
    var setOfIncomingPresentations = [];


    /**
     * Pending promise for the first incoming presentation connection.
     *
     * The promise is set by the first call to getConnection and returned
     * afterwards.
     *
     * @private
     * @type {Promise}
     */
    var pendingPromise = null;

    /**
     * Pending resolve function to call when the first incoming presentation
     * connection is detected.
     *
     * The function is set by the UA when getConnection is called before any
     * presentation connection is available.
     *
     * @private
     * @type {function}
     */
    var pendingResolveFunction = null;


    /**
     * Monitor incoming presentation connections
     *
     * @function
     * @private
     */
    var monitorIncomingPresentationConnections = function () {
      queueTask(function () {
        var connection = null;
        registeredMechanisms.forEach(function (mechanism) {
          mechanism.monitorIncomingContexts();
          mechanism.onincomingcontext = function (context) {
            log('new incoming presentation connection');
            connection = new PresentationConnection(context);
            connection.display.open().then(function () {
              connection.id = 'connection-' + setOfIncomingPresentations.length;
              setOfIncomingPresentations.push({
                url: null,
                id: connection.id,
                connection: connection
              });
              queueTask(function () {
                if (thisPresentationReceiver.onconnection) {
                  thisPresentationReceiver.onconnection();
                }
                if (pendingResolveFunction) {
                  pendingResolveFunction(connection);
                  pendingResolveFunction = null;
                  pendingPromise = null;
                }
              });
            });
          };
        });
      });
    };


    // Detects whether there is already a connection attached with this
    // receiving context when the shim is loaded. The code is the same as for
    // "getConnection", except that it allows the controlling and receiving
    // browsing contexts to setup the communication channel immediately
    window.addEventListener('load', function () {
      log('info', 'check whether code is running in a presentation receiver app');
      monitorIncomingPresentationConnections();
    });
  };




  /**********************************************************************
  Presentation interface
  **********************************************************************/

  /**
   * Implements the main Presentation interface, exposed on navigator
   *
   */
  var Presentation = function () {
    /**
     * The default presentation request that the user-agent should use
     * when user chooses to start the presentation from the user-agent
     * chrome.
     *
     * @type {PresentationRequest}
     */
    this.defaultRequest = null;

    /**
     * The main receiving interface
     * (only defined in the receiving browsing context)
     *
     * @type {PresentationReceiver}
     */
    this.receiver = new PresentationReceiver();
  };




  /**
   * Non-standard function exposed so that this shim may know how to map
   * a URL to be presented to a Cast receiver application on a Chromecast
   * device
   *
   * @function
   * @param {String} url URL of the receiver application
   * @param {String} id The Cast application ID associated with that URL
   */
  Presentation.prototype.registerCastApplication = function (url, id) {
    CastPresentationMechanism.registerCastApplication(url, id);
  };




  /**********************************************************************
  Register known presentation mechanisms
  **********************************************************************/
  registerPresentationMechanism(new WindowPresentationMechanism());
  registerPresentationMechanism(new CastPresentationMechanism());




  /**********************************************************************
  Expose interfaces to the global scope (prefixed with W3C)
  **********************************************************************/

  // Expose the Presentation API to the navigator object
  // (prefixed with W3C)
  navigator.w3cPresentation = new Presentation();

  // Expose the PresentationRequest constructor to the window object
  window.w3cPresentationRequest = PresentationRequest;
}());