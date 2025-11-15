const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs-extra');
const path = require('path');

/**
 * SSL Certificate Generation Utility
 */
class SSLCertificateGenerator {
    constructor() {
        this.certDir = '/etc/ssl/certs';
        this.keyDir = '/etc/ssl/private';
    }

    /**
     * Generate self-signed SSL certificate for DNS services
     */
    async generateSelfSignedCertificate(options = {}) {
        try {
            const {
                commonName = 'localhost',
                organizationName = 'NDash DNS Server',
                countryCode = 'US',
                stateOrProvinceName = 'State',
                localityName = 'City',
                emailAddress = 'admin@localhost',
                validityDays = 365,
                keySize = 2048,
                certFile = 'ndash.crt',
                keyFile = 'ndash.key'
            } = options;

            const certPath = path.join(this.certDir, certFile);
            const keyPath = path.join(this.keyDir, keyFile);

            console.log(`Generating self-signed SSL certificate...`);
            console.log(`Certificate: ${certPath}`);
            console.log(`Private Key: ${keyPath}`);

            // Create OpenSSL configuration for certificate
            const opensslConfig = `
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = ${countryCode}
ST = ${stateOrProvinceName}
L = ${localityName}
O = ${organizationName}
CN = ${commonName}
emailAddress = ${emailAddress}

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${commonName}
DNS.2 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
`;

            // Write temporary config file
            const configPath = '/tmp/openssl.conf';
            await fs.writeFile(configPath, opensslConfig, 'utf8');

            // Generate private key
            console.log('Generating private key...');
            await execPromise(`openssl genrsa -out "${keyPath}" ${keySize}`);

            // Generate certificate signing request
            console.log('Generating certificate signing request...');
            await execPromise(`openssl req -new -key "${keyPath}" -out /tmp/cert.csr -config "${configPath}"`);

            // Generate self-signed certificate
            console.log('Generating self-signed certificate...');
            await execPromise(`openssl x509 -req -days ${validityDays} -in /tmp/cert.csr -signkey "${keyPath}" -out "${certPath}" -extensions v3_req -extfile "${configPath}"`);

            // Set proper permissions
            await execPromise(`chmod 644 "${certPath}"`);
            await execPromise(`chmod 600 "${keyPath}"`);
            await execPromise(`chown root:root "${certPath}" "${keyPath}"`);

            // Clean up temporary files
            await fs.remove('/tmp/cert.csr');
            await fs.remove(configPath);

            // Verify certificate
            const { stdout: certInfo } = await execPromise(`openssl x509 -in "${certPath}" -text -noout | head -20`);
            console.log('Certificate generated successfully:');
            console.log(certInfo);

            return {
                success: true,
                certPath,
                keyPath,
                message: `SSL certificate generated successfully`
            };

        } catch (error) {
            console.error('Failed to generate SSL certificate:', error.message);
            throw new Error(`SSL certificate generation failed: ${error.message}`);
        }
    }

    /**
     * Check if certificate and key files exist
     */
    async checkCertificateExists(certFile = 'ndash.crt', keyFile = 'ndash.key') {
        const certPath = path.join(this.certDir, certFile);
        const keyPath = path.join(this.keyDir, keyFile);

        const certExists = await fs.pathExists(certPath);
        const keyExists = await fs.pathExists(keyPath);

        return {
            certExists,
            keyExists,
            certPath,
            keyPath
        };
    }

    /**
     * Get certificate information
     */
    async getCertificateInfo(certFile = 'ndash.crt') {
        try {
            const certPath = path.join(this.certDir, certFile);
            const { stdout } = await execPromise(`openssl x509 -in "${certPath}" -text -noout`);

            // Extract key information
            const subjectMatch = stdout.match(/Subject: (.+)/);
            const issuerMatch = stdout.match(/Issuer: (.+)/);
            const validityMatch = stdout.match(/Not Before: (.+)\nNot After : (.+)/);

            return {
                subject: subjectMatch ? subjectMatch[1].trim() : 'Unknown',
                issuer: issuerMatch ? issuerMatch[1].trim() : 'Unknown',
                validFrom: validityMatch ? validityMatch[1].trim() : 'Unknown',
                validTo: validityMatch ? validityMatch[2].trim() : 'Unknown'
            };
        } catch (error) {
            return {
                error: `Failed to read certificate: ${error.message}`
            };
        }
    }
}

module.exports = new SSLCertificateGenerator();