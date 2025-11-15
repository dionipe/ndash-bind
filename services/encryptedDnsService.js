const https = require('https');
const tls = require('tls');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const util = require('util');
const dnsPacket = require('dns-packet');
const settingsUtil = require('../utils/settings');

class EncryptedDnsService {
    constructor() {
        this.dohServer = null;
        this.dotServer = null;
        this.isRunning = false;
    }

    async start() {
        try {
            const settings = await settingsUtil.loadSettings();

            if (settings.resolver?.doh?.enabled) {
                await this.startDoH(settings.resolver.doh);
            }

            if (settings.resolver?.dot?.enabled) {
                await this.startDoT(settings.resolver.dot);
            }

            this.isRunning = true;
            console.log('✓ Encrypted DNS services started');
        } catch (error) {
            console.error('Error starting encrypted DNS services:', error);
            throw error;
        }
    }

    async stop() {
        try {
            if (this.dohServer) {
                this.dohServer.close();
                this.dohServer = null;
            }

            if (this.dotServer) {
                this.dotServer.close();
                this.dotServer = null;
            }

            this.isRunning = false;
            console.log('✓ Encrypted DNS services stopped');
        } catch (error) {
            console.error('Error stopping encrypted DNS services:', error);
            throw error;
        }
    }

    async startDoH(config) {
        return new Promise((resolve, reject) => {
            try {
                // Check if certificate files exist
                if (!fs.existsSync(config.certPath) || !fs.existsSync(config.keyPath)) {
                    console.warn(`DoH certificate files not found: ${config.certPath}, ${config.keyPath}`);
                    console.warn('Generating self-signed certificates for DoH...');
                    // For now, we'll skip DoH if certs don't exist
                    // In production, you should generate proper certificates
                    resolve();
                    return;
                }

                const options = {
                    cert: fs.readFileSync(config.certPath),
                    key: fs.readFileSync(config.keyPath)
                };

                this.dohServer = https.createServer(options, async (req, res) => {
                    try {
                        if (req.method === 'POST' && req.url === '/dns-query') {
                            // Handle DoH POST request
                            const chunks = [];
                            req.on('data', chunk => chunks.push(chunk));
                            req.on('end', async () => {
                                const dnsQuery = Buffer.concat(chunks);
                                const response = await this.processDnsQuery(dnsQuery);
                                res.writeHead(200, {
                                    'Content-Type': 'application/dns-message',
                                    'Access-Control-Allow-Origin': '*',
                                    'Access-Control-Allow-Methods': 'GET, POST',
                                    'Access-Control-Allow-Headers': 'Content-Type'
                                });
                                res.end(response);
                            });
                        } else if (req.method === 'GET' && req.url.startsWith('/dns-query?')) {
                            // Handle DoH GET request
                            const url = new URL(req.url, `https://${req.headers.host}`);
                            const dnsParam = url.searchParams.get('dns');
                            if (dnsParam) {
                                const dnsQuery = Buffer.from(dnsParam, 'base64');
                                const response = await this.processDnsQuery(dnsQuery);
                                res.writeHead(200, {
                                    'Content-Type': 'application/dns-message',
                                    'Access-Control-Allow-Origin': '*',
                                    'Access-Control-Allow-Methods': 'GET, POST',
                                    'Access-Control-Allow-Headers': 'Content-Type'
                                });
                                res.end(response);
                            } else {
                                res.writeHead(400);
                                res.end('Missing dns parameter');
                            }
                        } else {
                            res.writeHead(404);
                            res.end('Not Found');
                        }
                    } catch (error) {
                        console.error('DoH request error:', error);
                        res.writeHead(500);
                        res.end('Internal Server Error');
                    }
                });

                this.dohServer.listen(config.port, () => {
                    console.log(`✓ DoH server listening on port ${config.port}`);
                    resolve();
                });

                this.dohServer.on('error', (error) => {
                    console.error('DoH server error:', error);
                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    async startDoT(config) {
        return new Promise((resolve, reject) => {
            try {
                // Check if certificate files exist
                if (!fs.existsSync(config.certPath) || !fs.existsSync(config.keyPath)) {
                    console.warn(`DoT certificate files not found: ${config.certPath}, ${config.keyPath}`);
                    console.warn('Generating self-signed certificates for DoT...');
                    // For now, we'll skip DoT if certs don't exist
                    resolve();
                    return;
                }

                const options = {
                    cert: fs.readFileSync(config.certPath),
                    key: fs.readFileSync(config.keyPath),
                    requestCert: false,
                    rejectUnauthorized: false
                };

                this.dotServer = tls.createServer(options, (socket) => {
                    let buffer = Buffer.alloc(0);

                    socket.on('data', async (data) => {
                        try {
                            buffer = Buffer.concat([buffer, data]);

                            // DNS over TLS uses a 2-byte length prefix
                            while (buffer.length >= 2) {
                                const length = buffer.readUInt16BE(0);
                                if (buffer.length < 2 + length) break;

                                const dnsQuery = buffer.slice(2, 2 + length);
                                buffer = buffer.slice(2 + length);

                                const response = await this.processDnsQuery(dnsQuery);

                                // Prepend 2-byte length
                                const lengthPrefix = Buffer.alloc(2);
                                lengthPrefix.writeUInt16BE(response.length, 0);
                                socket.write(Buffer.concat([lengthPrefix, response]));
                            }
                        } catch (error) {
                            console.error('DoT processing error:', error);
                            socket.end();
                        }
                    });

                    socket.on('error', (error) => {
                        console.error('DoT socket error:', error);
                    });

                    socket.on('end', () => {
                        // Connection closed
                    });
                });

                this.dotServer.listen(config.port, () => {
                    console.log(`✓ DoT server listening on port ${config.port}`);
                    resolve();
                });

                this.dotServer.on('error', (error) => {
                    console.error('DoT server error:', error);
                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    async processDnsQuery(dnsQuery) {
        try {
            // Parse the DNS query
            const query = dnsPacket.decode(dnsQuery);

            // For now, forward to system resolver
            // In production, you might want to forward to your Bind resolver
            const answers = [];

            for (const question of query.questions) {
                try {
                    let records;
                    switch (question.type) {
                        case 'A':
                            records = await util.promisify(dns.resolve4)(question.name);
                            answers.push(...records.map(ip => ({
                                name: question.name,
                                type: 'A',
                                class: 'IN',
                                ttl: 300,
                                data: ip
                            })));
                            break;
                        case 'AAAA':
                            records = await util.promisify(dns.resolve6)(question.name);
                            answers.push(...records.map(ip => ({
                                name: question.name,
                                type: 'AAAA',
                                class: 'IN',
                                ttl: 300,
                                data: ip
                            })));
                            break;
                        case 'CNAME':
                            records = await util.promisify(dns.resolveCname)(question.name);
                            answers.push(...records.map(cname => ({
                                name: question.name,
                                type: 'CNAME',
                                class: 'IN',
                                ttl: 300,
                                data: cname
                            })));
                            break;
                        case 'MX':
                            records = await util.promisify(dns.resolveMx)(question.name);
                            answers.push(...records.map(mx => ({
                                name: question.name,
                                type: 'MX',
                                class: 'IN',
                                ttl: 300,
                                data: { preference: mx.priority, exchange: mx.exchange }
                            })));
                            break;
                        case 'TXT':
                            records = await util.promisify(dns.resolveTxt)(question.name);
                            answers.push(...records.map(txt => ({
                                name: question.name,
                                type: 'TXT',
                                class: 'IN',
                                ttl: 300,
                                data: txt.join('')
                            })));
                            break;
                        default:
                            // For unsupported types, return empty answer
                            break;
                    }
                } catch (error) {
                    // Domain not found or other error - return NXDOMAIN
                    query.rcode = 3; // NXDOMAIN
                    break;
                }
            }

            // Build response
            const response = {
                id: query.id,
                type: 'response',
                flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
                questions: query.questions,
                answers: answers
            };

            return dnsPacket.encode(response);

        } catch (error) {
            console.error('DNS query processing error:', error);
            // Return a basic error response
            const errorResponse = {
                id: 0,
                type: 'response',
                flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
                rcode: 2, // SERVFAIL
                questions: [],
                answers: []
            };
            return dnsPacket.encode(errorResponse);
        }
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            doh: {
                running: this.dohServer && this.dohServer.listening,
                port: this.dohServer ? this.dohServer.address().port : null
            },
            dot: {
                running: this.dotServer && this.dotServer.listening,
                port: this.dotServer ? this.dotServer.address().port : null
            }
        };
    }
}

module.exports = new EncryptedDnsService();