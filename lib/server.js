var util = require('./util');
//usr--
//var bodyParser = require('body-parser');
var WebSocket = require('ws');
var WebSocketServer = WebSocket.Server;

//--usr
var url = require('url');
var cors = require('cors');

var app = exports = module.exports = {};

/*usr-*/
var resolvePath = require("resolvePathMy"),
  commonlib = require(resolvePath(__dirname, "common.js")),
  //application settings getter
  globalAppSettings = require(resolvePath(__dirname, "settings/settings.js")),
  //cookies-parsing for reading of the session id
  //cookieParserFunction = require("cookie-parser")(appSettingsGetter.getCookiesSettings("secret"),appSettingsGetter.CookiesSettings),
  //store for session for reading session data
  //!!!userSession = require(path.resolve("inner_modules/userSession.js")),
  //mock server response object for using into cookieParserFunction, because we have not standard server response object
  //mockResponse = require("node-mocks-http").createResponse(),
  _log = require(resolvePath(__dirname, "logger.js")).loggerMsg(__filename);

var _defaultKey = globalAppSettings.gServerSettings.defaultKey;

var request = require('request');
var promise = require('bluebird');
var purest = require('purest')({request, promise});
var config = require('@purest/providers');

var dbIdentification = require(resolvePath(__dirname, "dbIdentification.js"));

var _gServer,
  messagesSettings = globalAppSettings.messagesSettings,
  prefixForMessagesGServer = messagesSettings.prefixMessagesForGServer,
  prefixForMessagesGServerLength = prefixForMessagesGServer.length,
  prefixForMessagesGServerLengthPlusOne = prefixForMessagesGServerLength,
  webSocketHeartbeatMessage = messagesSettings.webSocketHeartbeatMessage;

//options for cors
var originDomainsWhitelist = ["http://" + globalAppSettings.mainDomain, "http://" + globalAppSettings.mainDomain + ":" + globalAppSettings.mainPort, "http://client-usr1.c9.io", "http://client-usr1.c9.io : 8080"]; //whitelist of origin domains
function setCORSOptions(req, callback) {
  var originHeader = req.headers["origin"], //origin domain
    corsOptions = {
      origin: false,
      credentials: true
    };
  if (originHeader && originDomainsWhitelist.indexOf(originHeader.trim()) !== -1) { //if the domain is into the whitelist
    corsOptions.origin = true; //allow access
  }
  callback(null, corsOptions); //return options for CORS middleware
}


function sendErrorWhileLogin(socket) {
  socket.send('{"type": "ERROR","payload": {"msg": "No id, token, or key supplied to websocket server"}}');
  socket.close(1008);
}

//clientRequest - instance of http.ClientRequest
//socket - instance of Socket or http.ServerResponce
//return next(clientRequest, socket, Error) if an error or next(clientRequest, socket, null)
// function initializeSession(clientRequest, socket, callback) {
//   var self = this;
//   //cookieParserFunction(clientRequest, mockResponse, //parse cookies
//   //function () {
//   // !!!userSession.sessionStart(clientRequest, mockResponse,  //start user session
//   //     function () {
//   //         if (!userSession.validateSession(clientRequest)) {  //validate session
//   //             //if the session is not valid
//   //             sendErrorWhileLogin(socket);
//   //             return;
//   //         }
//   //         if ( callback ) {
//   //              function
//   //         }
//   //     }
//   // );
//   //clientRequest.session = {};
//   //callback.call(self, clientRequest, socket, null);  //apply self as this into callback
//   //}
//   //);
//   clientRequest.session = {};
//   callback.call(self, clientRequest, socket, null); //apply self as this into callback
// }

//connection instance of PeerJS socket
app.closeConnection = function(reason, connection) {
  var socket = connection == null ? this : connection;
  var msg = typeof(reason) === "object" && typeof(reason.message) === "string" ? reason.messge : "Closed";
  if ( socket.readyState !== 3 ) {
    try{
      socket.send('{"type": "ERROR","payload": {"msg": ' + msg + '}}');
      socket.close(1008);
    } catch(e) {
      console.log(e);  
    }
  }
};

/*
  identify the client by his external id and get the inner id from the database
*/
app.afterIdentification = function (innerID) { //inner ID of the user has gotten
  const self = this.app;
  const clientSession = this.session;
  const key = this.key; 
  const ip  = this.ip;
  const id  = this.id;
  const token = this.token;
  const socket = this.socket;
  
  if ( socket.readyState === 1 ) { //if the socket is in OPEN state
    clientSession.userID = innerID; //set the inner user id for the user session
    self._clients[_defaultKey][innerID] = //save the inner id
    self._clients[key][id] = {
      token: token,
      ip: ip,
      _g_session: clientSession
    };
  
    //usr
    self._ips[ip]++; //increase the number of connections from this ip
    self._numClients++; //increase the number of the connected clients
  
    socket.send('{"type": "OPEN", "userID" : ' + innerID + '}'); //send the inner id to the user
    self._configureWS(socket, key, id, innerID, token);
    
    self["_gServer_onConnection"](innerID); //handle the new connection
    return true;
  } else {
    return Promise.reject(new Error("Socket is closed"));  
  }
};

/*
  usr
  after the user was authentificated by the auth provider
  res- the answer to the auth request
*/
app.afterAuthintification = function(res) {
  var _socket = this.socket;
  var self = this.app;
  
  if (_socket.readyState === 1) { //if in the OPEN state
    if ( Array.isArray(res) !== true //check for ther answer
      || res.length !== 2
      || typeof(res[1]) !== "object"
      || typeof(res[1].id) !== "string" ) {
        self.closeConnection("Unknown answer from auth provider", _socket); //facebook return an error
    } else {
      var id  = res[1].id.trim();
      var authProviderID = this["_id"]; //id for the auth provider
      if (id === this["_id"]) { //if id given from facebook by the token and from the user are equals
        //identify the client by his external id and get the inner id from the database
        return dbIdentification
              .getInnerUserID(authProviderID, this.snPrefix) //get the inner user id
              .bind(this)
              .then(self.afterIdentification);
      } else {
        self.closeConnection("Wrong user id", _socket); //facebook return an error  
      }  
    }  
  } else {
    return Promise.reject(new Error("Socket is closed"));  
  }
 
};

/*
  check auth provider requests for timeout
*/
app.authProviderTimeoutRequest = function() {
  
  const requestList = this.authProviderRequests; //[ 0 : { timestamp, pr }]
  if ( typeof(requestList) === "object" ) {
      const len = requestList.length;
      const currentTimestamp = Date.now();
      const pendingPromises = []; //promises that are pending but still not timeout will be pushed on here
      
      if (len !== undefined
        && len > 0 ) {
          const errorTimeout = new Error("Time out");
          var ind = 0;
          for ( var i = 0; i < len; i++ ) {
            var _req = requestList[i]; //get a request from the list
            if ( _req != null 
                && typeof(_req.timestamp) === "number"
                && _req.pr != null ) {
                  var _promise = _req.pr;
                  if ( typeof(_promise.isPending) === "function"
                    && _promise.isPending() === true //if still pending
                    && currentTimestamp - _req.timestamp < 5000 ) { //runs less than 5 seconds
                      pendingPromises[ind++] = _req; //put the promise, that still pending and not timed out back to the list 
                  } else 
                    if ( typeof(_promise.isPending) !== "function" //if not a promise, but something unknown
                      || _promise.isPending() === true) { //or if still pending
                        if ( typeof(_promise._reject) === "function" ) {
                          _promise._reject();
                        }
                        if ( _req.socket != null ) { //if there is no method to reject a promise, then close the socket connection
                          this.closeConnection(errorTimeout, _req.socket);
                        }
                  }
            }
          } 
      }
      this.authProviderRequests = pendingPromises;
  }
    
};

/*
  if error on auth
*/
app.onAuthRejected = function(e) {
  if ( this.socket != null) {
    this.app.closeConnection( e != null ? e.message : "", this.socket); //facebook return an error 
  }
};

/*
  usr
  set options of the incoming connection
*/
app.initializeWSConnection = function(clientReq, socket, result) {
  if (result instanceof Error) {
    return;
  }

  var self = this;
  
  //parse the client request
  var query = url.parse(socket.upgradeReq.url, true).query;
  
  if ( typeof(query.id) !== "string"
      || typeof(query.token) !== "string" 
      || typeof(query.authservicename) !== "string" ) {
        self.closeConnection("Wrong request", socket); //facebook return an error      
  }
  
  var _id   = encodeURIComponent(query.id.trim()); //id of the user in the auth service
  var token = decodeURIComponent(query.token.trim()); //acess token provided by auth service
  var authProviderName = encodeURIComponent(query.authservicename.trim().toLowerCase()); //auth provider name
  
  //create the new client session
  var session = clientReq.session = {};
  session.id = _id; //save the external user id

  if (typeof(_id) !== "string"
      || typeof(token) !== "string" ) {
        self.closeConnection("No id, token supplied to websocket server", socket); //facebook return an error
  } else {
    
    //identify the client
    var authProvider = self.auth[authProviderName]; //get service to work with the auth provider rest api
    
    if ( authProvider == null ) {
        self.closeConnection("Unsupported auth provider", socket); //facebook return an error     
    } else {
    
      const authOptions = authProvider.options;
      const snPrefix = authOptions.dbKeyPrefix; //prefix for auth provider
      var id  = snPrefix + _id; //social user id
      const key = snPrefix;
      var ip;
      const headerXForwarded = clientReq.headers["g_client_ip"];
      
      const upgradeReq = socket.upgradeReq;
      if ( typeof(headerXForwarded) === "string"
          && headerXForwarded.length > 7) { //if forwarded
            ip = headerXForwarded;
      } else
        if ( upgradeReq != null
          && upgradeReq.socket != null
          && typeof(upgradeReq.socket.remoteAddress) === "string"
          && upgradeReq.socket.remoteAddress.length > 7 ) {
            ip  = socket.upgradeReq.socket.remoteAddress;
      } else {
        self.closeConnection("Unknown ip address of the user", socket);
      }

      /*
        check if the client is not connected
      */
      if (self._clients[key] == null //if the users for the social network are absent
        || self._clients[key][id] == null //if the user is mot connected
        || self._clients[key][id].token !== token) { //if the token are not equals
          var err = self._checkKey(key, ip);
          if (err instanceof Error === false) {
            if (self._clients[key][id] == null) { 
              const listPedingPromises = this.authProviderRequests;
              listPedingPromises[listPedingPromises.length] = { //put into the list of pending auth requests to a service providers
                timestamp : Date.now(),
                socket : socket,
                pr : authProvider
                      .provider
                      .query(authOptions.query)
                      .get(authOptions.get)
                      .auth(token)
                      .request()
                      .bind({ //bind the client options for afterAuthintification method
                        socket : socket,
                        session : session,
                        token : token,
                        ip : ip,
                        snPrefix : snPrefix,
                        key : key,
                        _id : _id,
                        app : self
                      })
                      .then(self.afterAuthintification)
                      .catch(self.onAuthRejected)
              };
            }
          }
          else {
            self.closeConnection(err, socket);
          }
      }
      else { //if the client is online
        self.identification(socket, key, id, _id, clientReq.session, token, ip);
      }
    }
  }
};

/*
  usr
  on new incoming WebSocket connection
*/
app.onIncomingConnection = function (socket) {
  this.initializeWSConnection(socket.upgradeReq, socket);
};

/** Initialize WebSocket server. */
app._initializeWSS = function (server) {

  if (this.mountpath instanceof Array) {
    throw new Error("This app can only be mounted on a single path");
  }

  var path = this.mountpath;
  path = path + (path[path.length - 1] != '/' ? '/' : '') + 'peerjs';

  var self = this;
  
  /*
    start time interval to check auth requests that are timed out
  */
  self.int_authProviderTimeoutRequest = setInterval(app.authProviderTimeoutRequest.bind(self), 5000);
  
  /*
    list with a requests to auth providers
  */
  self.authProviderRequests = [];
  
  var _integration = globalAppSettings.integration;
  this.auth = { //authification providers (social networks)
    "facebook" : {
      provider: purest({provider: 'facebook', config}),
      options : _integration["facebook"]
    },
    "google"    : {
      provider: purest({provider: 'google', config}),
      options : _integration["google"]
    },
    "windows" : {
      provider: purest({provider: 'live', config}),
      options : _integration["microsoft"]
    }
  };
  
  // Create WebSocket server as well.
  this._wss = new WebSocketServer({
    path: path,
    server: server
  });
  this._wss.on('connection', app.onIncomingConnection.bind(this));
  this._wss.on('error', function (err) {
    _log(err);
  });

  //usr--
  this._numClients = 0; //a number of connected clients
  var listClients = this._clients[_defaultKey] = [];
  for (var i = 0; i < globalAppSettings.geoServerSettings.lengthOfClientsList; i++) {
    listClients[i] = undefined;
  }
  _gServer = require(resolvePath(__dirname, "gServer.js"))(self);
  //--usr

};

/*
  on incoming message from WebSocket connection
*/
app.onSocketMessage = function (data, binary, context) {
  
  var self    = this;
  var socket  = context.socket;
  var client  = context.client;
  var innerID = context.innerID;
  
  //usr-
  if (data == null
    || data === webSocketHeartbeatMessage) { //if the message is empty or it is the heartbeat message
      return;
  }

  var message;
  if (data.indexOf(prefixForMessagesGServer) === 0) { //if found prefix, this means that this message is for processing b the gServer
    try {
      //handle the message by the gServer
      if (_gServer.onMessage(data.substr(prefixForMessagesGServerLengthPlusOne), socket, client) !== true) { //if this message is valid
        self._log('Invalid message');
        return;
      }
    }
    catch (e) {
      self._log('Invalid message');
      _log(e);
      return;
    }
  }
  else {
    try {
      message = JSON.parse(data);
    }
    catch (e) {
      util.prettyError('Invalid message');
      _log(e);
    return;
    }
  }
  
  //-usr

  var type = message.type;
    
  try { //usr-
    switch (type) {
    case 'LEAVE':
    case 'CANDIDATE':
    case 'OFFER':
    case 'ANSWER':
      self._handleTransmission(
        _defaultKey, //use the default key and the inner id
        {
          type: type,
          src: innerID,
          dst: message.dst,
          payload: message.payload
        }
      );
      break;
    default:
      util.prettyError('Message unrecognized');
    }
  }
  catch (e) {
    self._log('Invalid message', data);
    throw e;
  }
  
};

/*-usr */

app._configureWS = function (socket, key, id, innerID, token) {

  var self = this;
  var client = this._clients[key][id];

  //usr--
  if (client == null) {
    this._clients[key][id] = {};
  }

  if (client.socket !== socket &&
    client.socket instanceof WebSocket &&
    client.socket.readyState !== WebSocket.CLOSED) {
    client.socket.close(); //close the previos connection
  }

  client.token = token; //set this socket for the client
  client.socket = socket;
  // Client already exists
  if (client.res) {
    client.res.end();
  }

  //--usr

  this._processOutstanding(key, id);

  function socketOnClose() {
    var err = new Error();
    console.log(err.stack);
    self._numClients--;
    _gServer.onSocketClose(id, socket);
    self._log('Socket closed:', id);
    if (client.socket == socket) {
      self._removePeer(key, id);
    }
  }

  socket.on('error', function (err) {
    //usr--
    _log(err);
    if (socket._g_numOfErrors == null) {
      socket._g_numOfErrors = 1;
    }
    else {
      socket._g_numOfErrors++;
    }
    if (socket._g_numOfErrors > 10) { //if more then ten errors has ocurred
      socket.close(1008);
    }
    return; //--usr
  });

  // Cleanup after a socket closes.
  socket.on('close', socketOnClose);

  // Handle messages from peers.
  socket.on(
      'message',
      ( data,
        binary,
        context = {
            socket  : socket,
            innerID : innerID,
            client  : client }
      ) => self.onSocketMessage(data, binary, context)
  );

  // We're going to emit here, because for XHR we don't *know* when someone
  // disconnects.
  //this.emit('connection', innerID);
};

app._checkAllowsDiscovery = function (key, cb) {
  cb(this._options.allow_discovery);
};

app._checkKey = function (key, ip, cb) {
  if (!this._clients[key]) {
    this._clients[key] = {};
  }
  if (!this._outstanding[key]) {
    this._outstanding[key] = {};
  }
  if (!this._ips[ip]) {
    this._ips[ip] = 0;
  }
  // Check concurrent limit
  if (this._numClients >= this._options.concurrent_limit) {
    return new Error('Server has reached its concurrent user limit');
  }
  if (this._ips[ip] >= this._options.ip_limit) {
    return new Error(ip + ' has reached its concurrent user limit');
  }
};

/** Initialize HTTP server routes. */
/*app._initializeHTTP = function() {
  var self = this;

  //usr--
  this.use(cors(setCORSOptions));
  //this.use(cookieParserFunction);
  //this.use(userSession.sessionStart);!!!

  // Retrieve USER ID.
  this.get('/:key/id', function(req, res, next) {
      //!!! if ( !userSession.validateSession(req)) {
      //     res.send("Access denied!");
      //     return;
      // }
      req.session = {};
      req.session.userID = 1;
      var usrSession = req.session;
      res.contentType = 'text/html';
      var userID = req.session.userID;
      var generatedID = self._generateClientId(req.params.key);
      res.send(userID+"");
  });

  //usr--
  function gServerHTTP (res, req, next) {
     req.send("Not supported yet");
     //!!! initializeSession(res, req, next);
  }

  //this.use(gServerHTTP);


    // Retrieve guaranteed random ID.
    this.get('/:key/id', function (req, res, next) {
        res.contentType = 'text/html';
        res.send(self._generateClientId(req.params.key));
    });

  this.get('/', function(req, res, next) {
    res.send(require('../app.json'));
  });

  // Server sets up HTTP streaming when you get post an ID.
  this.post('/:key/:id/:token/id', function(req, res, next) {
    var id = req.params.id;
    var token = req.params.token;
    var key = req.params.key;
    var ip = req.connection.remoteAddress;

    if (!self._clients[key] || !self._clients[key][id]) {
      self._checkKey(key, ip, function(err) {
        if (!err && !self._clients[key][id]) {
          self._clients[key][id] = { token: token, ip: ip };
          self._ips[ip]++;
          self._startStreaming(res, key, id, token, true);
        } else {
          res.send('{ "type": "HTTP-ERROR" }');
        }
      });
    } else {
      self._startStreaming(res, key, id, token);
    }
  });

  // Get a list of all peers for a key, enabled by the `allowDiscovery` flag.
  this.get('/:key/peers', function(req, res, next) {
    var key = req.params.key;
    if (self._clients[key]) {
      self._checkAllowsDiscovery(key, function(isAllowed) {
        if (isAllowed) {
          res.send(Object.keys(self._clients[key]));
        } else {
          res.sendStatus(401);
        }
      });
    } else {
      res.sendStatus(404);
    }
  });

  var handle = function(req, res, next) {
    var key = req.params.key;
    var id = req.params.id;

    var client;
    if (!self._clients[key] || !(client = self._clients[key][id])) {
      if (req.params.retry) {
        res.sendStatus(401);
      } else {
        // Retry this request
        req.params.retry = true;
        setTimeout(handle, 25, req, res);
        return;
      }
    }

    // Auth the req
    if (req.params.token !== client.token) {
      res.sendStatus(401);
      return;
    } else {
      self._handleTransmission(key, {
        type: req.body.type,
        src: id,
        dst: req.body.dst,
        payload: req.body.payload
      });
      res.sendStatus(200);
    }
  };

  var jsonParser = bodyParser.json();

  this.post('/:key/:id/:token/offer', jsonParser, handle);

  this.post('/:key/:id/:token/candidate', jsonParser, handle);

  this.post('/:key/:id/:token/answer', jsonParser, handle);

  this.post('/:key/:id/:token/leave', jsonParser, handle);

    //usr--
    function gServer_handleHTTP(req, res, next) {
        var type = req.body.type;
        var msg = req.body;
        res.end("Not supported yet");
    }

    this.post('/:key/:id/:token/gserver', jsonParser, cors(setCORSOptions), gServer_handleHTTP);
    //--usr
};

/** Saves a streaming response and takes care of timeouts and headers. */
app._startStreaming = function (res, key, id, token, open) {
  var self = this;

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream'
  });

  var pad = '00';
  for (var i = 0; i < 10; i++) {
    pad += pad;
  }
  res.write(pad + '\n');

  if (open) {
    res.write("{ type: 'OPEN' })" + '\n');
  }

  var client = this._clients[key][id];

  if (token === client.token) {
    // Client already exists
    res.on('close', function () {
      if (client.res === res) {
        if (!client.socket) {
          // No new request yet, peer dead
          self._removePeer(key, id);
          return;
        }
        delete client.res;
      }
    });
    client.res = res;
    this._processOutstanding(key, id);
  }
  else {
    // ID-taken, invalid token
    res.end("{ type: 'HTTP-ERROR' }");
  }
};

app._pruneOutstanding = function () {
  var keys = Object.keys(this._outstanding);
  for (var k = 0, kk = keys.length; k < kk; k += 1) {
    var key = keys[k];
    var dsts = Object.keys(this._outstanding[key]);
    for (var i = 0, ii = dsts.length; i < ii; i += 1) {
      var offers = this._outstanding[key][dsts[i]];
      var seen = {};
      for (var j = 0, jj = offers.length; j < jj; j += 1) {
        var message = offers[j];
        if (!seen[message.src]) {
          this._handleTransmission(key, {
            type: 'EXPIRE',
            src: message.dst,
            dst: message.src
          });
          seen[message.src] = true;
        }
      }
    }
    this._outstanding[key] = {};
  }
};

/** Cleanup */
app._setCleanupIntervals = function () {
  var self = this;
  var openState = WebSocket.OPEN;

  // Clean up ips every 10 minutes
  setInterval(function () {
    var keys = Object.keys(self._ips);
    for (var i = 0, ii = keys.length; i < ii; i += 1) {
      var key = keys[i];
      if (self._ips[key] === 0) {
        delete self._ips[key];
      }
    }
  }, 600000);

  // Clean up outstanding messages every 5 seconds
  setInterval(function () {
    self._pruneOutstanding();
  }, 5000);
};

/** Process outstanding peer offers. */
app._processOutstanding = function (key, id) {
  var offers = this._outstanding[key][id];
  if (!offers) {
    return;
  }
  for (var j = 0, jj = offers.length; j < jj; j += 1) {
    this._handleTransmission(key, offers[j]);
  }
  delete this._outstanding[key][id];
};

app._removePeer = function (key, id) {
  if (this._clients[key] && this._clients[key][id]) {
    this._ips[this._clients[key][id].ip]--;
    delete this._clients[key][id];
    this.emit('disconnect', id);
  }
};

/** Handles passing on a message. */
app._handleTransmission = function (key, message) {
  var type = message.type;
  var src = message.src;
  var dst = message.dst;
  var data = JSON.stringify(message);

  var destination = this._clients[key][dst];

  // User is connected!
  if (destination) {
    try {
      this._log(type, 'from', src, 'to', dst);
      if (destination.socket) {
        destination.socket.send(data);
      }
      else if (destination.res) {
        data += '\n';
        destination.res.write(data);
      }
      else {
        // Neither socket no res available. Peer dead?
        throw "Peer dead";
      }
    }
    catch (e) {
      // This happens when a peer disconnects without closing connections and
      // the associated WebSocket has not closed.
      // Tell other side to stop trying.
      this._removePeer(key, dst);
      this._handleTransmission(key, {
        type: 'LEAVE',
        src: dst,
        dst: src
      });
    }
  }
  else {
    // Wait for this client to connect/reconnect (XHR) for important
    // messages.
    if (type !== 'LEAVE' && type !== 'EXPIRE' && dst) {
      if ( !this._outstanding[key] ) {
        this._outstanding[key] = {};
        console.log(message); 
      }
      if (!this._outstanding[key][dst]) {
        this._outstanding[key][dst] = [];
      }
      this._outstanding[key][dst].push(message);
    }
    else if (type === 'LEAVE' && !dst) {
      this._removePeer(key, src);
    }
    else {
      // Unavailable destination specified with message LEAVE or EXPIRE
      // Ignore
    }
  }
};

app._generateClientId = function (key) {
  //var clientId = util.randomId();
  var clientId = Math.floor(Math.random() * 10000 + 1); //!!!!
  if (!this._clients[key]) {
    return clientId;
  }
  while (!!this._clients[key][clientId]) {
    clientId = util.randomId();
  }
  return clientId;
};

app._log = function () {
  if (this._options.debug) {
    console.log.apply(console, arguments);
  }
};
