"use strict";

var util = require("util");
var assert = require("assert");

var EventEmitter2 = require("eventemitter2").EventEmitter2;
var Binary = require("binary");

function BlizzardSession(id, socket, methods, instigator) {
    var sequence = 0;

    this.socket = socket;

    // Did our side start the connection?
    this.instigator = instigator;

    this.methods = methods;
    this.requestCallbacks = {};
    this.streams = {};

    // This ID represents a request-response pair.
    Object.defineProperty(this, "sequence", {
        get: function () {
            return sequence;
        },
        set: function (newSequence) {
            // Blizzard IDs are 32-bit unsigned integers.
            // Numbers higher than MAX_ID can not be
            // represented, so rollover to 0.
            if (newSequence > BlizzardSession.MAX_ID) {
                newSequence = 0;
            }
            sequence = newSequence;
        }
    });

    EventEmitter2.call(this, {
        wildcard: true
    });

    if (process.env.BLIZZARD_DEBUG) {
        this.onAny(function () {
            console.log.apply(this, [
                "[BlizzardSession]",
                instigator ? "-->" : "<--",
                this.event
            ].concat(Array.prototype.slice.call(arguments, 0)));
        });
    }

    this.setupBinaryParser(this.socket);

    // Handle incoming raw JSON string.
    this.on("incomingJSON", this.onIncomingJSON.bind(this));

    // Handle incoming raw Buffer.
    this.on("buffer", this.bufferPut.bind(this));

    // Handle incoming Buffer EOF.
    this.on("bufferComplete", this.bufferComplete.bind(this));

    // Handle parsed JSON message.
    this.on("message", this.onMessage.bind(this));

    // Handle errors.
    this.on("fail", this.onFailure.bind(this));

    // Close when the remote socket closes.
    this.socket.on("end", this.emit.bind(this, "end"));
    this.on("end", this.end.bind(this));

    // If we're the client, tell the server the client is ready.
    if (this.instigator) {
        this.xferRawZeroLength(BlizzardSession.TYPE_HANDSHAKE, 0);
    }
}

util.inherits(BlizzardSession, EventEmitter2);

BlizzardSession.MAGIC = 89;

BlizzardSession.TYPE_HANDSHAKE = 0;
BlizzardSession.TYPE_JSON = 1;
BlizzardSession.TYPE_BUFFER_RESPONSE = 3;

// Maximum 32-bit unsigned integer.
BlizzardSession.MAX_ID = Math.pow(2, 32) - 1;

BlizzardSession.ERROR_USER = -32000;
BlizzardSession.ERROR_PARSE = -32700;
BlizzardSession.ERROR_INVALID = -32600;
BlizzardSession.ERROR_METHOD = -32601;
BlizzardSession.ERROR_INTERNAL = -32603;

BlizzardSession.prototype.end = function () {
    this.socket.end();
    this.socket.destroySoon();
};

BlizzardSession.prototype.expose = function (name, fn) {
    this.methods[name] = fn;
};

BlizzardSession.prototype.socketReady = function () {
    return this.socket && this.socket.writable;
};

BlizzardSession.prototype.xferRawZeroLength = function (type, id) {
    assert(this.socketReady(), "Socket not writable.");
    assert(!isNaN(id), "ID must be a number.");

    var header = new Buffer(10);
    header.writeUInt8(BlizzardSession.MAGIC, 0);
    header.writeUInt8(type, 1);
    header.writeUInt32BE(id, 2);
    header.writeUInt32BE(0, 6);

    this.socket.write(header);
};

BlizzardSession.prototype.xferRaw = function (type, id, buffer) {
    assert(this.socketReady(), "Socket not writable.");
    assert(!isNaN(id), "ID must be a number.");
    assert(Buffer.isBuffer(buffer), "Buffer required.");

    var packet = new Buffer(10 + buffer.length);
    packet.writeUInt8(BlizzardSession.MAGIC, 0);
    packet.writeUInt8(type, 1);
    packet.writeUInt32BE(id, 2);
    packet.writeUInt32BE(buffer.length, 6);
    buffer.copy(packet, 10);

    this.socket.write(packet);
};

BlizzardSession.prototype.xferObject = function (id, json) {
    this.xferRaw(BlizzardSession.TYPE_JSON,
        id, new Buffer(JSON.stringify(json), "utf8"));
};

BlizzardSession.prototype.xferBuffer = function (id, buffer) {
    this.xferRaw(BlizzardSession.TYPE_BUFFER_RESPONSE, id, buffer);
};

BlizzardSession.prototype.request = function (method, params, cb) {
    var id = 0,
        rpc = {
            method: method
        };

    if ("function" === typeof params) {
        // Called with method, cb -- params omitted.
        cb = params;
        params = null;
    }

    if (params) {
        rpc.params = params;
    }

    if (cb) {
        assert("function" === typeof cb, "Function expected for callback argument.");
        id = this.nextSequence();
        this.requestCallbacks[id] = cb;
    }

    this.xferObject(id, rpc);
};

BlizzardSession.prototype.reply = function (id, message) {
    if (!id) {
        throw new Error("id required for reply");
    }
    if (Buffer.isBuffer(message)) {
        this.xferBuffer(id, message);
        // TODO - Streaming
        this.xferRawZeroLength(BlizzardSession.TYPE_BUFFER_RESPONSE, id);
    } else {
        this.xferObject(id, {
            "result": message
        });
    }
};

BlizzardSession.prototype.onFailure = function (id, code, error) {
    if (id === 0) {
        // Unable to reply. Is this our fault?
        if (code === BlizzardSession.ERROR_INTERNAL) {
            // Crash the program.
            this.emit("error", error);
        }
        // Otherwise, do nothing.
    } else {
        // Reply with the error details.
        this.xferObject(id, {
            error: {
                code: code,
                message: error
            }
        });
    }
};

BlizzardSession.prototype.callRequestCallback = function (id, error, result) {
    assert(id);

    var requestCallback = this.requestCallbacks[id];

    // Free the callback.
    delete this.requestCallbacks[id];

    if (requestCallback) {
        requestCallback(error, result);
    } else {
        // If error exists, both sides do not know about this ID. Ignore.
        // Responding would cause a ERROR_INTERNAL loop.
        if (!error) {
            this.emit("fail", id, BlizzardSession.ERROR_INTERNAL, "Could not find callback for this ID.");
        }
    }
};

BlizzardSession.prototype.onIncomingJSON = function (id, jsonString) {
    var message;

    try {
        message = JSON.parse(jsonString);
    } catch (ex) {
        this.emit("fail", id,
            BlizzardSession.ERROR_PARSE,
            new Error("Unable to parse JSON: " +
                JSON.stringify(jsonString)));
        return;
    }

    if (message.length) {
        this.emit("fail", id, BlizzardSession.ERROR_INVALID, "Expected an object, got an array.");
    }

    this.emit("message", id, message);
};


BlizzardSession.prototype.onMessage = function (id, message) {
    var self = this,
        notification = id !== 0,
        params = [];

    function onComplete(error, reply) {
        if (error) {
            self.emit("fail", id, BlizzardSession.ERROR_USER, error);
        } else if (id) {
            self.reply(id, reply);
        }
        // No ID means request() was called on the other end
        // without a callback. No response was desired.
    }

    if (message.method) {
        // Verify the request.
        if (message.params) {
            params = message.params;
        }
        // Look up the method.
        if (self.methods[message.method]) {
            self.methods[message.method](params, onComplete);
        } else {
            self.emit("fail", id, BlizzardSession.ERROR_METHOD, "Method " + message.method + " not found.");
        }
    } else if (id) {
        if (message.error) {
            self.callRequestCallback(id, message.error);
        } else if (message.result) {
            self.callRequestCallback(id, null, message.result);
        } else {
            self.emit("fail", id, BlizzardSession.ERROR_INVALID, "Messages with IDs must contain method, error, or result.");
        }
    } else {
        self.emit("fail", id, BlizzardSession.ERROR_INVALID, "Messages without IDs must contain method.");
    }
};

BlizzardSession.prototype.bufferComplete = function (id) {
    var stream = this.streams[id]; // node-put object

    if (!stream) {
        this.emit("fail", id, BlizzardSession.ERROR_INVALID, "Got final packet for a stream that does not exist.");
        return;
    }

    // Free the stream.
    delete this.streams[id];

    this.emit("message", id, {
        "result": stream.buffer()
    });
};

BlizzardSession.prototype.bufferPut = function (id, buffer) {
    var stream = this.streams[id];

    if (!stream) {
        this.streams[id] = Binary.put();
    }

    this.streams[id].put(buffer);
};

BlizzardSession.prototype.nextSequence = function () {
    if (this.instigator) {
        this.sequence = this.sequence + 2;
    } else {
        this.sequence = this.sequence + 1;
    }
    return this.sequence;
};

BlizzardSession.prototype.updateSequence = function (vars) {
    var id = vars.id;

    if (isNaN(id) || id === 0) {
        return;
    }

    if (this.sequence < id) {
        // TODO test these cases
        this.sequence = id + 1;
    }
};

BlizzardSession.prototype.setupBinaryParser = function (socket) {
    var self = this;

    (function start() {
        Binary.stream(socket).loop(function (end) {
            // The magic byte indicates the protocol version.
            // Validate it's correct before attempting parsing.
            this.word8("magic").tap(function parseMagic(vars) {
                if (vars.magic !== BlizzardSession.MAGIC) {
                    self.emit("fail", 0, BlizzardSession.ERROR_INVALID, "Unexpected value for magic byte.");

                    // Restart the parser.
                    end();
                    start();
                }
            });

            // Read the header.
            this.word8("type");
            this.word32be("id");
            this.word32be("length");

            this.tap(self.updateSequence.bind(self));

            // Parse the header.
            this.tap(function parseHeader(vars) {
                if (vars.length === 0) {
                    if (vars.type === BlizzardSession.TYPE_BUFFER_RESPONSE) {
                        self.emit("bufferComplete", vars.id);
                    } else if (vars.type === BlizzardSession.TYPE_HANDSHAKE) {
                        self.emit("ready");
                    } else {
                        self.emit("fail", vars.id, BlizzardSession.ERROR_INVALID, "Unexpected 0-length header.");
                    }
                } else {
                    this.buffer("data", vars.length);
                }
            });

            // Parse the buffered data, if applicable.
            this.tap(function parsePacket(vars) {
                var jsonString, message;
                if (vars.data) {
                    if (vars.type === BlizzardSession.TYPE_JSON) {
                        self.emit("incomingJSON", vars.id, vars.data.toString("utf8"));
                    } else if (vars.type === BlizzardSession.TYPE_BUFFER_RESPONSE) {
                        self.emit("buffer", vars.id, vars.data);
                    } else {
                        self.emit("fail", vars.id, BlizzardSession.ERROR_INVALID, "Unknown packet type.");
                    }
                }
            });

            // Clear variables for next loop.
            this.flush();
        });
    }());
};

module.exports = BlizzardSession;