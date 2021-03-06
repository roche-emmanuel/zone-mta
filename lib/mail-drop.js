'use strict';

const config = require('config');
const log = require('npmlog');
const MessageParser = require('./message-parser');
const PassThrough = require('stream').PassThrough;
const DkimRelaxedBody = require('./dkim-relaxed-body');
const plugins = require('./plugins');
const mailsplit = require('mailsplit');
const util = require('util');
const libmime = require('libmime');

// Processes a message stream and stores it to queue

class MailDrop {
    constructor(queue) {
        this.queue = queue;
    }

    add(envelope, source, callback) {
        if (!this.queue) {
            return setImmediate(() => callback(new Error('Queue not yet initialized')));
        }

        envelope = envelope || {};

        if (typeof source === 'string') {
            let messageBuf = Buffer.from(source);
            source = new PassThrough();
            source.once('error', err => callback(err));
            source.end(messageBuf);
        } else if (Buffer.isBuffer(source)) {
            let messageBuf = source;
            source = new PassThrough();
            source.once('error', err => callback(err));
            source.end(messageBuf);
        }

        let id = envelope.id;

        let messageInfo = {
            'message-id': '<>',
            from: envelope.from || '<>',
            to: [].concat(envelope.to || []).join(',') || '<>',
            format() {
                let values = [];
                Object.keys(this).forEach(key => {
                    if (typeof messageInfo[key] === 'function') {
                        return;
                    }
                    values.push(util.format('%s=%s', key, messageInfo[key]));
                });
                return values.join(' ');
            }
        };

        let message = new MessageParser();
        message.onHeaders = (headers, next) => {
            envelope.headers = headers;

            let subject = envelope.headers.getFirst('subject');
            try {
                subject = libmime.decodeWords(subject);
            } catch (E) {
                // ignore
            }
            subject = subject.replace(/[\x00-\x1F]+/g, '_').trim(); //eslint-disable-line no-control-regex
            if (subject.length > 64) {
                subject = subject.substr(0, 60) + '...[+' + (subject.length - 60) + 'B]';
            }

            plugins.handler.runHooks('message:headers', [envelope], err => {
                messageInfo['message-id'] = envelope.messageId;
                messageInfo.subject = '"' + subject + '"';

                if (envelope.envelopeFromHeader) {
                    messageInfo.from = envelope.from || '<>';
                    messageInfo.to = [].concat(envelope.to || []).join(',') || '<>';
                }

                if (err) {
                    return setImmediate(() => next(err));
                }
                setImmediate(next);
            });
        };

        let raw = new PassThrough();
        let splitter = new mailsplit.Splitter({
            ignoreEmbedded: true
        });
        let streamer = new PassThrough({
            objectMode: true
        });

        envelope.dkim = envelope.dkim || {};
        envelope.dkim.hashAlgo = envelope.dkim.hashAlgo || config.dkim.hashAlgo || 'sha256';
        envelope.dkim.debug = envelope.dkim.hasOwnProperty('debug') ? envelope.dkim.debug : config.dkim.debug;

        let dkimStream = new DkimRelaxedBody(envelope.dkim);
        dkimStream.on('hash', bodyHash => {
            // store relaxed body hash for signing
            envelope.dkim.bodyHash = bodyHash;
            envelope.bodySize = dkimStream.byteLength;
            messageInfo.body = envelope.bodySize || 0;
        });

        plugins.handler.runAnalyzerHooks(envelope, source, raw);
        raw.pipe(splitter);
        plugins.handler.runRewriteHooks(envelope, splitter, streamer);
        plugins.handler.runStreamHooks(envelope, streamer, message);
        message.pipe(dkimStream);

        splitter.once('error', err => {
            raw.emit('error', err);
        });

        dkimStream.once('error', err => {
            message.emit('error', err);
        });

        plugins.handler.runHooks('message:store', [envelope, dkimStream], err => {
            if (err) {
                return setImmediate(() => callback(err));
            }

            // store stream to db
            this.queue.store(id, dkimStream, err => {
                if (err) {
                    if (source.readable) {
                        source.resume(); // let the original stream to end normally before displaying the error message
                    }
                    log.error('Queue/' + process.pid, '%s NOQUEUE "%s" (%s)', id, err.message, messageInfo.format());
                    return callback(err);
                }

                plugins.handler.runHooks('message:queue', [envelope, messageInfo], err => {
                    if (err) {
                        return setImmediate(() => callback(err));
                    }

                    // convert headers object to a serialized array
                    envelope.headers = envelope.headers ? envelope.headers.getList() : [];

                    // inject message headers to the stored stream
                    this.queue.setMeta(id, envelope, err => {
                        if (err) {
                            log.error('Queue/' + process.pid, '%s NOQUEUE "%s" (%s)', id, err.message, messageInfo.format());
                            return callback(err);
                        }

                        // push delivery data
                        this.queue.push(id, envelope, err => {
                            if (err) {
                                log.error('Queue/' + process.pid, '%s NOQUEUE "%s" (%s)', id, err.message, messageInfo.format());
                                return callback(err);
                            }
                            log.info('Queue/' + process.pid, '%s QUEUED (%s)', id, messageInfo.format());
                            return setImmediate(() => callback(null, 'Message queued as ' + id));
                        });
                    });
                });
            });
        });
    }
}

module.exports = MailDrop;
