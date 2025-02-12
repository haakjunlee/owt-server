// Copyright (C) <2019> Intel Corporation
//
// SPDX-License-Identifier: Apache-2.0

'use strict';
var InternalIO = require('../internalIO/build/Release/internalIO');
var SipGateway = require('../sipIn/build/Release/sipIn');
var SipCallConnection = require('./sipCallConnection').SipCallConnection;
var InternalIn = InternalIO.In;
var InternalOut = InternalIO.Out;
var logger = require('../logger').logger;
var rpcClient;
var path = require('path');
var makeRPC = require('../makeRPC').makeRPC;

var cluster_name = ((global.config || {}).cluster || {}).name || 'owt-cluster';

// Logger
var log = logger.getLogger('SipNode');
var {InternalConnectionRouter} = require('./internalConnectionRouter');

// Setup GRPC server
var createGrpcInterface = require('./grpcAdapter').createGrpcInterface;
var enableGRPC = global.config.agent.enable_grpc || false;
var EventEmitter = require('events').EventEmitter;
var grpcNode = {};

// resolution map
var resolution_map = {
    'sif' : {'width' : 352, 'height' : 240},
    'vga' : {'width' : 640, 'height' : 480},
    'hd720p' : {'width' : 1280, 'height' : 720},
    'hd1080p' : {'width' : 1920, 'height' : 1080},
    'svga' : {'width' : 800, 'height' : 600},
    'r640x360' : {'width' : 640, 'height' : 360}
};

function safeCall () {
  var callback = arguments[0];
  if (typeof callback === 'function') {
    var args = Array.prototype.slice.call(arguments, 1);
    callback.apply(null, args);
  }
}

function do_join(conference_ctl, user_id, user_name, room, selfPortal, ok, err) {
    makeRPC(
        rpcClient,
        conference_ctl,
        'join',
        [room, {id: user_id, user: user_name, role: 'sip', portal: selfPortal}], function(joinResult) {
            log.debug('join ok');
            safeCall(ok, joinResult.room.streams);
        }, function (reason) {
            safeCall(err,reason);
        });
}

function do_leave(conference_ctl, user) {
    makeRPC(
        rpcClient,
        conference_ctl,
        'leave',
        [user],
        function() {
            log.debug('leave ok');
        });

}
function do_query(conference_ctl, user, room, ok, err) {
    makeRPC(
        rpcClient,
        conference_ctl,
        'query',
        [user, room], function(streams) {
            safeCall(ok, streams);
        }, function(reason) {
            safeCall(err, reason);
        });
}

function do_publish(conference_ctl, user, stream_id, stream_info) {
    return new Promise(function(resolve, reject) {
        makeRPC(
            rpcClient,
            conference_ctl,
            'publish',
            [user, stream_id, stream_info],
            resolve,
            reject);
    }).then((result) => {
      return new Promise(function(resolve, reject) {
        makeRPC(
            rpcClient,
            conference_ctl,
            'streamControl',
            [user, stream_id, {id: stream_id, operation: 'mix', data: 'common'}],
            resolve,
            reject);
      });
    });
}

function do_subscribe(conference_ctl, user, subscription_id, subInfo) {
    return new Promise(function(resolve, reject) {
        makeRPC(
            rpcClient,
            conference_ctl,
            'subscribe',
            [user, subscription_id, subInfo],
            resolve,
            reject);
    });
}

function do_unpublish(conference_ctl, user, stream_id) {
    return new Promise(function(resolve, reject) {
        makeRPC(
            rpcClient,
            conference_ctl,
            'unpublish',
            [user, stream_id],
            resolve,
            reject);
    });
}

function do_unsubscribe(conference_ctl, user, subscription_id) {
    return new Promise(function(resolve, reject) {
        makeRPC(
            rpcClient,
            conference_ctl,
            'unsubscribe',
            [user, subscription_id],
            resolve,
            reject);
    });
}

var getConferenceControllerForRoom = function (roomId, on_ok, on_error) {
    var keepTrying = true;

    var tryFetchingConferenceController = function (attempts) {
        if (attempts <= 0) {
            return on_error('Timeout to fetech controller');
        }

        log.debug('Send controller schedule RPC request to ', cluster_name, ' for room ', roomId);

        makeRPC(rpcClient, cluster_name, 'schedule', ['conference', roomId, 'preference'/*FIXME:should fill-in actual preference*/, 60 * 1000],
            function (result) {
                makeRPC(rpcClient, result.id, 'getNode', [{room: roomId, task: roomId}], function (ConferenceController) {
                    on_ok(ConferenceController);
                    keepTrying = false;
                }, function(reason) {
                    if (keepTrying) {
                        log.warn('Failed on get node for', roomId, ', keep trying.');
                        setTimeout(function () {tryFetchingConferenceController(attempts - (reason === 'timeout' ? 4 : 1));}, 1000);
                    }
                });
            }, function (reason) {
                if (keepTrying) {
                    log.warn('Failed on scheduling conference controller for', roomId, ', keep trying.');
                    setTimeout(function () {tryFetchingConferenceController(attempts - (reason === 'timeout' ? 4 : 1));}, 1000);
                }
            });
    };

    tryFetchingConferenceController(25);
};

function translateProfile (profLevId) {
    var profile_idc = profLevId.substr(0, 2);
    var profile_iop = parseInt(profLevId.substr(2, 2), 16);
    var profile;
    switch (profile_idc) {
        case '42':
            if (profile_iop & (1 << 6)) {
                // x1xx0000
                profile = 'CB';
            } else {
                // x0xx0000
                profile = 'B';
            }
            break;
        case '4D':
            if (profile_iop && (1 << 7)) {
                // 1xxx0000
                profile = 'CB';
            } else if (!(profile_iop && (1 << 5))) {
                profile = 'M';
            }
            break;
        case '58':
            if (profile_iop && (1 << 7)) {
                if (profile_iop && (1 << 6)) {
                    profile = 'CB';
                } else {
                    profile = 'B';
                }
            } else if (!(profile_iop && (1 << 6))) {
                profile = 'E';
            }
            break;
        case '64':
            (profile_iop === 0) && (profile = 'H');
            break;
        case '6E':
            (profile_iop === 0) && (profile = 'H10');
            (profile_iop === 16) && (profile = 'H10I');
            break;
        case '7A':
            (profile_iop === 0) && (profile = 'H42');
            (profile_iop === 16) && (profile = 'H42I');
            break;
        case 'F4':
            (profile_iop === 0) && (profile = 'H44');
            (profile_iop === 16) && (profile = 'H44I');
            break;
        case '2C':
            (profile_iop === 16) && (profile = 'C44I');
            break;
        default:
            break;
    }
    return profile;
}

module.exports = function (rpcC, selfRpcId, parentRpcId, clusterWorkerIP) {
    rpcClient = rpcC;

    var that = {
      agentID: parentRpcId,
      clusterIP: clusterWorkerIP
    },
        erizo = {id:selfRpcId, addr:clusterWorkerIP},
        room_id,
        gateway,
        sip_server,
        streams = {},
        calls = {},
        subscriptions = {},
        recycling_mode = false;
    // For GRPC notifications
    var streamingEmitter = new EventEmitter();

    var router = new InternalConnectionRouter(global.config.internal);

    if (enableGRPC) {
        const grpcTools = require('./grpcTools');
        cluster_name = global.config?.cluster?.grpc_host || 'localhost:10080';
        makeRPC = function (_, node, method, args, onOk, onError) {
            if (method === 'schedule') {
                if (!grpcNode[node]) {
                    grpcNode[node] = grpcTools.startClient('clusterManager', node);
                }
                const req = {
                    purpose: args[0],
                    task: args[1],
                    preference: {}, // Change data for some preference
                    reserveTime: args[3]
                  };
                grpcNode[node].schedule(req, (err, result) => {
                    if (!err) {
                        onOk({id: result.info.ip + ':' + result.info.grpcPort});
                    } else {
                        onError(err);
                    }
                });
            } else if (method === 'getNode') {
                if (!grpcNode[node]) {
                    grpcNode[node] = grpcTools.startClient('nodeManager', node);
                }
                grpcNode[node].getNode({info: args[0]}, (err, result) => {
                    if (!err) {
                        onOk(result.message);
                    } else {
                        onError(err);
                    }
                });
            } else if (method === 'join') {
                if (!grpcNode[node]) {
                    grpcNode[node] = grpcTools.startClient('conference', node);
                }
                const req = {
                    roomId: args[0],
                    participant: args[1]
                };
                grpcNode[node].join(req, (err, result) => {
                    if (!err) {
                        onOk(result);
                    } else {
                        onError(err);
                    }
                });
            } else if (method === 'leave') {
                if (!grpcNode[node]) {
                    grpcNode[node] = grpcTools.startClient('conference', node);
                }
                grpcNode[node].leave({id: args[0]}, (err, result) => {
                    if (!err) {
                        onOk && onOk(result);
                    } else {
                        onError && onError(err);
                    }
                });
            } else if (method === 'publish') {
                if (!grpcNode[node]) {
                    grpcNode[node] = grpcTools.startClient('conference', node);
                }
                const req = {
                    participantId: args[0],
                    streamId: args[1],
                    pubInfo: args[2]
                };
                grpcNode[node].publish(req, (err, result) => {
                    if (!err) {
                        onOk(result);
                    } else {
                        onError(err);
                    }
                });
            } else if (method === 'streamControl') {
                if (!grpcNode[node]) {
                    grpcNode[node] = grpcTools.startClient('conference', node);
                }
                const req = {
                    participantId: args[0],
                    sessionId: args[1],
                    command: JSON.stringify(args[2])
                };
                grpcNode[node].streamControl(req, (err, result) => {
                    if (!err) {
                        onOk(result);
                    } else {
                        onError(err);
                    }
                });
            } else if (method === 'subscribe') {
                if (!grpcNode[node]) {
                    grpcNode[node] = grpcTools.startClient('conference', node);
                }
                const req = {
                    participantId: args[0],
                    subscriptionId: args[1],
                    subInfo: args[2]
                };
                grpcNode[node].subscribe(req, (err, result) => {
                    if (!err) {
                        onOk(result);
                    } else {
                        onError(err);
                    }
                });
            } else if (method === 'unsubscribe') {
                if (!grpcNode[node]) {
                    grpcNode[node] = grpcTools.startClient('conference', node);
                }
                const req = {
                    participantId: args[0],
                    sessionId: args[1],
                };
                grpcNode[node].unsubscribe(req, (err, result) => {
                    if (!err) {
                        onOk(result);
                    } else {
                        onError(err);
                    }
                });
            } else if (method === 'unpublish') {
                if (!grpcNode[node]) {
                    grpcNode[node] = grpcTools.startClient('conference', node);
                }
                const req = {
                    participantId: args[0],
                    sessionId: args[1]
                };
                grpcNode[node].unpublish(req, (err, result) => {
                    if (!err) {
                        onOk(result);
                    } else {
                        onError(err);
                    }
                });
            }
        };
    }

    var getClientId = function(peerURI) {
      for (var c_id in calls) {
        if (calls[c_id].peerURI === peerURI) {
          return c_id;
        }
      }
      return null;
    };

    var handleIncomingCall = function (client_id, peerURI, on_ok, on_error) {
        getConferenceControllerForRoom(room_id, function(result) {
            var conference_controller = result;
            calls[client_id] = {conference_controller: conference_controller, peerURI: peerURI};
            do_join(conference_controller, client_id, peerURI, room_id, erizo.id, function(streamList) {
                for (var index in streamList) {
                    if (streamList[index].type === 'mixed') {
                        if (streamList[index].info.label === 'common') {
                            calls[client_id].videoSource = streamList[index];
                            calls[client_id].audioSource = streamList[index];
                            break;
                        }
                    }
                }

                if (calls[client_id].videoSource || calls[client_id].audioSource){
                    on_ok();
                } else {
                    do_leave(conference_controller, client_id);
                    on_error('No mixed stream in room.');
                }
            }, function (err) {
                on_error(err);
            });
        }, on_error);
    };

    //TODO: should complete the following procedure to protect against the unexpected situations such as partial failure.
    var setupCall = function (client_id, info) {
        var conference_controller = calls[client_id].conference_controller;

        var published = Promise.resolve('ok');
        var subscribed = Promise.resolve('ok');

        var audio_info, video_info;
        if (info.audio) {
            var tmp;
            if (info.audio_codec === 'opus') {
               tmp = {codec: 'opus', sampleRate: 48000, channelNum: 2};
            } else if (info.audio_codec === 'PCMU') {
               tmp = {codec: 'pcmu'};
            } else if (info.audio_codec === 'PCMA') {
               tmp = {codec: 'pcma'};
            }
            audio_info = tmp;
        }
        if (info.video) {
            //TODO: device:camera, we may need to differentiate with screen sharing in the furture
            var codec = info.video_codec.toLowerCase();
            var tmp;
            if (codec === 'h264') {
              var pos = info.videoResolution.indexOf('profile-level-id=');
              var plid = info.videoResolution.substr(pos + 'profile-level-id='.length, 6);
              var prf = translateProfile(plid) || 'CB';
              tmp = {codec: 'h264', profile: prf, resolution: {width: 0, height: 0}, framerate: 0};
            } else {
              tmp = {codec: codec, resolution: {width: 0, height: 0}, framerate: 0};
            }
            video_info = tmp;
        }

        // publish stream to controller
        if ((info.audio && info.audio_dir !== 'sendonly') || (info.video && info.video_dir !== 'sendonly')) {
            var stream_id = Math.round(Math.random() * 1000000000000000000) + '';

            //TODO: the streams binding should be done in the success callback.
            streams[stream_id] = {type: 'sip', connection: calls[client_id].conn};
            calls[client_id].stream_id = stream_id;

            router.addLocalSource(stream_id, 'sip', calls[client_id].conn.source())
            .catch(e => log.warn('Unexpected error during source add:', e));

            var pubInfo = {type: 'sip', media: {}, locality: {agent:that.agentID, node: erizo.id}};
            if (info.audio && info.audio_dir !== 'sendonly') {
                pubInfo.media.audio = audio_info;
            }else {
                pubInfo.media.audio = false;
            }
            if (info.video && info.video_dir !== 'sendonly') {
                pubInfo.media.video = video_info;
            }else {
                pubInfo.media.video = false;
            }

            published = do_publish(calls[client_id].conference_controller,
                                   client_id,
                                   stream_id,
                                   pubInfo);
        }

        // subscribe the mix streams
        if ((info.audio && info.audio_dir !== 'recvonly') || (info.video && info.video_dir !== 'recvonly')) {
            var subscription_id = Math.round(Math.random() * 1000000000000000000) + '';
            var subInfo = { type: 'sip', media: {}, locality: {agent:that.agentID, node: erizo.id} };
            if (info.audio && info.audio_dir !== 'recvonly' && calls[client_id].audioSource) {
                subInfo.media.audio = {
                    from: calls[client_id].audioSource.id,
                    format: audio_info
                };
            }
            if (info.video && info.video_dir !== 'recvonly' && calls[client_id].videoSource) {
                subInfo.media.video = {
                    from: calls[client_id].videoSource.id,
                    format: {codec: video_info.codec, profile: video_info.profile}
                };

                if (calls[client_id].mediaOut && calls[client_id].mediaOut.video && calls[client_id].mediaOut.video.parameters) {
                    subInfo.media.video.parameters = calls[client_id].mediaOut.video.parameters;
                } else {
                    //check resolution
                    var fmtp = info.videoResolution,
                        preferred_resolution,
                        optional_resolutions = calls[client_id].videoSource.media.tracks.find(t => t.type === "video").optional.parameters.resolution;

                    const isResolutionEqual = (r1, r2) => {return r1.width === r2.width && r1.height === r2.height;};
                    //TODO: currently we only check CIF/QCIF, there might be other options in fmtp from other devices.
                    if((fmtp.indexOf('CIF') !== -1 || fmtp.indexOf('QCIF') !== -1) && optional_resolutions){
                        var required_resolution = ((fmtp.indexOf('CIF') !== -1) ? {width: 352, height: 288} : {width: 176, height: 144});
                        var diff = Number.MAX_VALUE;
                        for (var index in optional_resolutions) {
                            var current_diff = (optional_resolutions[index].width - 352) + (optional_resolutions[index].height - 288);
                            if (current_diff < diff){
                                diff = current_diff;
                                preferred_resolution = optional_resolutions[index];
                            }
                        }
                    }
                    preferred_resolution && (subInfo.media.video.parameters = {resolution: preferred_resolution});
                }
            }
            //TODO: The subscriptions binding should be done in the success callback.
            calls[client_id].subscription_id = subscription_id;
            subscriptions[subscription_id] = {type: 'sip',
                                        audio: undefined,
                                        video: undefined,
                                        connection: calls[client_id].conn};

            subscribed = do_subscribe(calls[client_id].conference_controller,
                                      client_id,
                                      subscription_id,
                                      subInfo);

            router.addLocalDestination(subscription_id, 'sip', calls[client_id].conn)
            .catch(e => log.warn('Unexpected error during destination add:', e));
        }

        return Promise.all([published, subscribed]).then(function(result) {
            log.debug('setup call ok:', info);
            if (calls[client_id]) {
                // keep the current info
                calls[client_id].currentInfo = info;
            }
            return info;
        }).catch((err) => {
          log.warn('Call denied...', err);
          if (calls[client_id]) {
              gateway.hangup(calls[client_id].peerURI);
              teardownCall(client_id);
              calls[client_id].conn && calls[client_id].conn.close();
              do_leave(calls[client_id].conference_controller, client_id);
              delete calls[client_id];
          }
        });
    };

    var teardownCall = function (client_id) {
        log.debug("teardownCall, client_id: ", client_id);
        var subscription_id = calls[client_id].subscription_id;
        if (subscriptions[subscription_id]) {
            router.removeConnection(subscription_id)
            .catch(e => log.warn('Unexpected error during subscription remove:', e));

            delete subscriptions[subscription_id];
            calls[client_id].subscription_id = undefined;
        }

        var stream_id = calls[client_id].stream_id;
        if (stream_id && streams[stream_id]) {
            router.removeConnection(stream_id)
            .catch(e => log.warn('Unexpected error during stream remove:', e));

            delete streams[stream_id];
            calls[client_id].stream_id = undefined;
        }
    };

    var notifyMediaUpdate = (peerURI, direction, mediaUpdate) => {
        log.debug('notifyMediaUpdate:', peerURI, 'direction:', direction, 'mediaUpdate:', mediaUpdate);
        var clientId = getClientId(peerURI);
        if (calls[clientId]) {
            if (direction === 'in' && calls[clientId].stream_id) {
                rpcClient.remoteCast(calls[clientId].conference_controller, 'onMediaUpdate', [calls[clientId].stream_id, direction, JSON.parse(mediaUpdate)]);
            }
        }
    };

    var handleCallEstablished = function (info) {
        log.debug('CallEstablished:', info.peerURI, 'audio='+info.audio, 'video='+info.video,
                 (info.audio ? (' audio codec:' + info.audio_codec + ' audio dir: ' + info.audio_dir) : ''),
                 (info.video ? (' video codec: ' + info.video_codec + ' video dir: ' + info.video_dir) : ''));
        var client_id = getClientId(info.peerURI);
        log.debug('client_id:', client_id, 'calls:', JSON.stringify(calls));
        var support_red = info.video? info.support_red : false;
        var support_ulpfec = info.video? info.support_ulpfec : false;

        if (client_id && calls[client_id]) {
            calls[client_id].conn = new SipCallConnection({gateway: gateway, peerURI: info.peerURI, audio : info.audio, video : info.video,
                red : support_red, ulpfec : support_ulpfec}, notifyMediaUpdate);
            setupCall(client_id, info)
            .catch(function(err) {
                log.error('Error during call establish:', err);
            });
        } else {
            log.error("gateway can not handle event with invalid status");
        }
    };

    var handleCallUpdated = function (info) {
        log.debug('CallUpdated:', info, calls);

        var client_id = getClientId(info.peerURI);
        var support_red = info.video? info.support_red : false;
        var support_ulpfec = info.video? info.support_ulpfec : false;

        if(!client_id || calls[client_id] === undefined || calls[client_id].conference_controller === undefined || calls[client_id].currentInfo === undefined) {
            log.warn('Call ' + client_id + ' not established, ignore it');
            return;
        }

        if (calls[client_id].updating) {
            log.warn("Too frequent call update request, process it later");
            calls[client_id].latestInfo = info;
            return;
        }

        // Call info compare function
        var infoEqual = function(a, b) {
            var audioEqual = (a.audio === b.audio);
            if (a.audio && b.audio) {
                audioEqual = (a.audio_codec === b.audio_codec && a.audio_dir === b.audio_dir);
            }
            var videoEqual = (a.video === b.video);
            if (a.video && b.video) {
                videoEqual = (a.video_codec === b.video_codec && a.videoResolution === b.videoResolution && a.video_dir === b.video_dir &&
                    a.support_red === b.support_red && a.support_ulpfec === b.support_ulpfec);
            }

            return (audioEqual && videoEqual);
        };

        // Ignore duplicate update requests
        if (infoEqual(calls[client_id].currentInfo, info)) {
            log.warn('Same as current info:', info, 'ignore it.');
            return;
        }

        calls[client_id].updating = true;

        var conference_controller = calls[client_id].conference_controller;
        var old_stream_id = calls[client_id].stream_id;
        var old_subscription_id = calls[client_id].subscription_id;

        // Ignore unpublish/unsubscribe failure for send-only/receive-only clients
        var unpublished = do_unpublish(conference_controller, client_id, old_stream_id)
            .then(function(ok) {
                return ok;
            }).catch(function(err) {
                return err;
            });
        var unsubscribed = do_unsubscribe(conference_controller, client_id, old_subscription_id).then(
            function(ok) {
                return ok;
            }).catch(function(err) {
                return err;
            });

        Promise.all([unpublished, unsubscribed])
        .then(function(result) {
            log.debug('handleCallUpdated unsubscribe/unpublish ok');

            teardownCall(client_id);
            // recreate a sip call connection
            calls[client_id].conn && calls[client_id].conn.close();
            calls[client_id].conn = new SipCallConnection({gateway: gateway, peerURI: calls[client_id].peerURI, audio : info.audio, video : info.video,
                red : support_red, ulpfec : support_ulpfec}, notifyMediaUpdate);
            return setupCall(client_id, info);
        })
        .then(function(result) {
            log.debug('handleCallUpdated re-setup call ok');
            calls[client_id].updating = undefined;

            if (calls[client_id].latestInfo) {
                // Process saved latest update request
                log.debug('Received call update request during updating');
                var latestInfo = calls[client_id].latestInfo;
                calls[client_id].latestInfo = undefined;

                handleCallUpdated(latestInfo);
            }
        }).catch(function(err) {
            log.error('Error during call updating:', err);
        });
    };

    var handleCallClosed = function (peerURI) {
        var client_id = getClientId(peerURI);

        log.debug('CallClosed:', client_id);
        if (client_id && calls[client_id]) {
            teardownCall(client_id);
            calls[client_id].conn && calls[client_id].conn.close();
            do_leave(calls[client_id].conference_controller, client_id);
            delete calls[client_id];
        }
    };

    that.init = function(options, callback) {
        log.debug('init SipGateway:', options.sip_server, options.sip_user);
        erizo.id = rpcC.rpcAddress

        if (typeof options.room_id !== 'string' || options.room_id === '') {
            log.error('Invalid room id');
            return callback('callback', 'error', 'Invalid room id');
        }

        if (typeof options.sip_server !== 'string' || options.sip_server === '') {
            log.error('Invalid sip server url');
            return callback('callback', 'error', 'Invalid sip server url');
        }

        if (typeof options.sip_user !== 'string' || options.sip_user === '') {
            log.error('Invalid sip user id');
            return callback('callback', 'error', 'Invalid sip user id');
        }

        if (options.sip_passwd && typeof options.sip_passwd !== 'string') {
            log.error('Invalid sip password');
            return callback('callback', 'error', 'Invalid sip password');
        }

        options.sip_passwd = (options.sip_passwd ? options.sip_passwd : '');

        if (gateway) {
            log.info('SipGateway already exists, ignore init request.');
            callback('callback', 'ok');
            return;
        }

        room_id = options.room_id;

        gateway = new SipGateway.SipGateway();

        gateway.addEventListener('SIPRegisterOK', function() {
            callback('callback', 'ok');
        });

        gateway.addEventListener('SIPRegisterFailed', function() {
            log.error("Register Failed");
            gateway && gateway.close();
            gateway = undefined;
            callback('callback', 'error', 'SIP registration fail');
        });

        if (!gateway.register(options.sip_server, options.sip_user, options.sip_passwd, options.sip_user)) {
            log.error("Register error!");
            gateway && gateway.close();
            gateway = undefined;
            callback('callback', 'error', 'SIP registration fail');
        }

        sip_server = options.sip_server;

        gateway.addEventListener('IncomingCall', function(peerURI) {
            log.debug('IncommingCall: ', peerURI);
            for (var cid in calls) {
                if (calls[cid].peerURI === peerURI) {
                    return log.error('Duplicated call from the same peer, ignore it.');
                }
            }

            if (!recycling_mode) {
                var client_id = 'SipIn' + Math.round(Math.random() * 10000000000000);
                handleIncomingCall(client_id, peerURI, function () {
                    log.debug('Accept call');
                    gateway.accept(peerURI);
                }, function (reason) {
                    log.error('reject call error: ', reason);
                    gateway.reject(peerURI);
                });
            } else {
                gateway.reject(peerURI);
                log.info('working on recycling mode, do not accept incoming call');
            }
        });

        gateway.addEventListener('CallEstablished', function(data) {
            var info = JSON.parse(data);
            handleCallEstablished(info);
        });

        gateway.addEventListener('CallUpdated', function(data) {
            var info = JSON.parse(data);
            handleCallUpdated(info);
        });

        gateway.addEventListener('CallClosed', function(peerURI) {
            handleCallClosed(peerURI);
        });
    };

    that.keepAlive = function (callback) {
      callback('callback', true);
    };

    that.clean = function() {
        log.debug('Clean SipGateway');

        recycling_mode = true;
        for (var client_id in calls) {
            log.debug('force leaving room ', room_id, ' user: ', client_id);
            gateway.hangup(calls[client_id].peerURI);
            teardownCall(client_id);
            calls[client_id].conn && calls[client_id].conn.close();
            do_leave(calls[client_id].conference_controller, client_id);
            delete calls[client_id];
        }
        gateway.close();
        gateway = undefined;
        recycling_mode = false;
    };

    that.getInternalAddress = function(callback) {
        const ip = global.config.internal.ip_address;
        const port = router.internalPort;
        callback('callback', {ip, port});
    };

    that.publish = function (stream_id, stream_type, options, callback) {
        log.debug('publish stream_id:', stream_id, ', stream_type:', stream_type, ', audio:', options.audio, ', video:', options.video);
        callback('callback', 'ok');
    };

    that.unpublish = function (stream_id, callback) {
        log.debug('unpublish enter, stream_id:', stream_id);
        callback('callback', 'ok');
    };

    that.subscribe = function (subscription_id, subscription_type, options, callback) {
        log.debug('subscribe, subscription_id:', subscription_id, ', subscription_type:', subscription_type, ',options:', options);
        callback('callback', 'ok');
    };

    that.unsubscribe = function (subscription_id, callback) {
        log.debug('unsubscribe, subscription_id:', subscription_id);
        callback('callback', 'ok');
    };

    var onSuccess = function (callback) {
        return function(result) {
            callback('callback', result);
        };
    };

    var onError = function (callback) {
        return function(reason) {
            if (typeof reason === 'string') {
                callback('callback', 'error', reason);
            } else {
                callback('callback', reason);
            }
        };
    };

    // streamInfo = {id: 'string', ip: 'string', port: 'number'}
    // from = {audio: streamInfo, video: streamInfo, data: streamInfo}
    that.linkup = function (connectionId, from, callback) {
        log.debug('linkup, connectionId:', connectionId, 'from:', from);
        router.linkup(connectionId, from).then(onSuccess(callback), onError(callback));
    };

    that.cutoff = function (connectionId, callback) {
        log.debug('cutoff, connectionId:', connectionId);
        router.cutoff(connectionId).then(onSuccess(callback), onError(callback));
    };

    that.drop = function(clientId, fromRoom) {
        log.debug('drop, clientId:', clientId, 'fromRoom:', fromRoom);
        if (calls[clientId]) {
            gateway.hangup(calls[clientId].peerURI);
            teardownCall(clientId);
            calls[clientId].conn && calls[clientId].conn.close();
            delete calls[clientId];
        }
    };

    that.makeCall = function(peerURI, mediaIn, mediaOut, controller, callback) {
        log.debug('makeCall, peerURI:', peerURI, 'mediaIn:', mediaIn, 'mediaOut:', mediaOut, 'controller:', controller);
        if (!peerURI.startsWith('sip:')) {
            peerURI = 'sip:' + peerURI;
        }

        if (!peerURI.includes('@')) {
            peerURI = peerURI + '@' + sip_server;
        }

        for (var cid in calls) {
            if (calls[cid].peerURI === peerURI) {
                log.error('Duplicated call to the same peer, ignore it.');
                return callback('callback', 'error', 'Duplicated call to the same peer');
            }
        }

        if ((!!mediaIn.audio !== !!mediaOut.audio) || (!!mediaIn.video !== !!mediaOut.video)) {
            log.error('Inconsistent audio/video input/output requirement');
            return callback('callback', 'error', 'Inconsistent audio/video in/out requirement');
        }

        if (!recycling_mode) {
            var client_id = 'SipOut' + Math.round(Math.random() * 1000000000000);
            if (gateway.makeCall(peerURI, !!mediaIn.audio, !!mediaIn.video)) {
                calls[client_id] = {conference_controller: controller, peerURI: peerURI};
                do_join(controller, client_id, peerURI, room_id, erizo.id, function(streamList) {
                    for(var index in streamList){
                        if (mediaOut.audio && mediaOut.audio.from && mediaOut.audio.from === streamList[index].id) {
                            calls[client_id].audioSource = streamList[index];
                        }
                        if (mediaOut.video && mediaOut.video.from && mediaOut.video.from === streamList[index].id) {
                            calls[client_id].videoSource = streamList[index];
                            calls[client_id].mediaOut = mediaOut;
                        }
                    }
                    if (calls[client_id].audioSource || calls[client_id].videoSource) {
                        callback('callback', client_id);
                    } else {
                        do_leave(controller, client_id);
                        log.error('No available streams in room');
                        callback('callback', 'error', 'No available streams in room');
                    }
                }, function (err) {
                    log.error(err);
                    callback('callback', 'error', 'Joining room failed');
                });
            } else {
                callback('callback', 'error', 'SipUA failed in making a call');
            }
        } else {
            log.error('working on recycling mode, can NOT make calls');
            callback('callback', 'error', 'Not available');
        }
    };

    that.endCall = function(clientId, callback) {
        log.debug('endCall, clientId:', clientId);
        if (calls[clientId]) {
            gateway.hangup(calls[clientId].peerURI);
            teardownCall(clientId);
            calls[clientId].conn && calls[clientId].conn.close();
            delete calls[clientId];
        }
        callback('callback', 'ok');
    };

    that.notify = function(participantId, event, data, callback) {
        //TODO: notify text message to sip end.
        callback('callback', 'ok');
    };

    that.close = function() {
        if (gateway) {
            this.clean();
        }
    };

    that.onFaultDetected = function (message) {
        if (message.purpose === 'conference') {
            for (var client_id in calls) {
                if (calls[client_id].conference_controller &&
                    ((message.type === 'node' && message.id === calls[client_id].conference_controller) || (message.type === 'worker' && calls[client_id].conference_controller.startsWith(message.id)))){
                    log.error('Fault detected on conference_controller:', message.id, 'of call:', client_id , ', terminate it');
                    gateway.hangup(calls[client_id].peerURI);
                    teardownCall(client_id);
                    calls[client_id].conn && calls[client_id].conn.close();
                    delete calls[client_id];
                }
            }
        }
    };

    if (enableGRPC) {
        // Export GRPC interface.
        return createGrpcInterface(that, streamingEmitter);
    }

    return that;
};
