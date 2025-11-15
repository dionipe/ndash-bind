const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class LightweightRPZService {
    constructor() {
        this.lightweightZoneFile = '/opt/ndash/lightweight-rpz.db';
        this.bindOptionsPath = '/etc/bind/named.conf.options';
        this.bindLocalPath = '/etc/bind/named.conf.local';
    }

    /**
     * Enable lightweight RPZ using BIND with response policy zone
     */
    async enableLightweightRPZ() {
        try {
            console.log('Enabling lightweight RPZ with BIND response policy zone...');

            // Convert domains to RPZ format (limit to 25k for lighter operation)
            await this.convertToRPZFormat(25000);

            // Add RPZ zone to BIND configuration
            await this.addRPZZoneToBindConfig();

            // Reload Bind
            await this.reloadBind();

            console.log('✓ Lightweight RPZ enabled with BIND response policy zone');
            return { success: true, message: 'Lightweight RPZ enabled' };
        } catch (error) {
            console.error('Error enabling lightweight RPZ:', error);
            throw error;
        }
    }

    /**
     * Convert domains to BIND RPZ format
     */
    async convertToRPZFormat(limit = 50000) {
        const domainsFile = '/opt/ndash/alsyundawy_blacklist.txt';

        if (!await fs.pathExists(domainsFile)) {
            throw new Error('Domain file not found');
        }

        const domains = [];
        const stream = fs.createReadStream(domainsFile, { encoding: 'utf8' });
        const readline = require('readline');

        const rl = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            const domain = line.trim();
            if (domain && !domain.startsWith('#')) {
                domains.push(domain);
                if (domains.length >= limit) break;
            }
        }

        rl.close();

        // Create RPZ zone file format
        let zoneContent = `\$TTL 60
@ IN SOA localhost. root.localhost. (
    2024111501 ; serial
    60         ; refresh
    60         ; retry
    60         ; expire
    60         ; minimum
)
@ IN NS localhost.

; Lightweight RPZ - Response Policy Zone for blocking
`;

        // Add RPZ records to block domains (NXDOMAIN for blocked domains)
        domains.forEach(domain => {
            zoneContent += `${domain} IN CNAME .\n`;
        });

        await fs.writeFile(this.lightweightZoneFile, zoneContent, 'utf8');
        console.log(`✓ Created lightweight RPZ zone file with ${domains.length} domains (${(zoneContent.length / 1024 / 1024).toFixed(2)} MB)`);
    }

    /**
     * Add RPZ zone to BIND configuration
     */
    async addRPZZoneToBindConfig() {
        // First, add the zone definition to named.conf.local
        const zoneConfig = `
// Lightweight RPZ Zone
zone "rpz-lightweight" {
    type master;
    file "${this.lightweightZoneFile}";
    allow-query { any; };
};
`;

        let localContent = '';
        try {
            localContent = await fs.readFile(this.bindLocalPath, 'utf8');
        } catch (error) {
            localContent = '';
        }

        // Remove existing lightweight zone
        localContent = localContent.replace(/\/\/ Lightweight RPZ Zone\nzone "rpz-lightweight"[^}]*};\n/g, '');

        // Add new zone
        localContent += zoneConfig;

        await fs.writeFile(this.bindLocalPath, localContent, 'utf8');

        // Now modify response-policy in named.conf.options
        let optionsContent = '';
        try {
            optionsContent = await fs.readFile(this.bindOptionsPath, 'utf8');
        } catch (error) {
            throw new Error('Could not read BIND options file');
        }

        // Check if there's already a response-policy block
        if (optionsContent.includes('response-policy {')) {
            // Add our zone to the existing response-policy block
            optionsContent = optionsContent.replace(
                /(response-policy\s*{\s*[^}]*)(\s*})/,
                `$1\n        zone "rpz-lightweight";$2`
            );
        } else {
            // Create new response-policy block
            const rpzConfig = `
// Lightweight RPZ
response-policy {
    zone "rpz-lightweight";
} break-dnssec yes;
`;

            // Insert before the closing brace of the options block
            optionsContent = optionsContent.replace(/(}\s*)$/, `${rpzConfig}$1`);
        }

        await fs.writeFile(this.bindOptionsPath, optionsContent, 'utf8');
        console.log('✓ Added lightweight RPZ zone to BIND configuration');
    }

    /**
     * Reload Bind service
     */
    async reloadBind() {
        try {
            const { stdout, stderr } = await execPromise('rndc reload');
            console.log('✓ Bind reloaded successfully');
            return { success: true, message: stdout };
        } catch (error) {
            console.error('✗ Failed to reload Bind:', error.message);
            throw new Error(`Bind reload failed: ${error.stderr || error.message}`);
        }
    }

    /**
     * Disable lightweight RPZ
     */
    async disableLightweightRPZ() {
        try {
            console.log('Disabling lightweight RPZ...');

            // Remove zone file
            await fs.remove(this.lightweightZoneFile).catch(() => {});

            // Remove zone from BIND local config
            let localContent = '';
            try {
                localContent = await fs.readFile(this.bindLocalPath, 'utf8');
                localContent = localContent.replace(/\/\/ Lightweight RPZ Zone\nzone "rpz-lightweight"[^}]*};\n/g, '');
                await fs.writeFile(this.bindLocalPath, localContent, 'utf8');
            } catch (error) {
                console.warn('Could not update BIND local config:', error.message);
            }

            // Remove response-policy zone from BIND options
            let optionsContent = '';
            try {
                optionsContent = await fs.readFile(this.bindOptionsPath, 'utf8');
                // Remove our zone from the response-policy block
                optionsContent = optionsContent.replace(/\s*zone "rpz-lightweight";\s*/g, '');
                await fs.writeFile(this.bindOptionsPath, optionsContent, 'utf8');
            } catch (error) {
                console.warn('Could not update BIND options config:', error.message);
            }

            // Reload Bind
            await this.reloadBind();

            console.log('✓ Lightweight RPZ disabled');
            return { success: true, message: 'Lightweight RPZ disabled' };
        } catch (error) {
            console.error('Error disabling lightweight RPZ:', error);
            throw error;
        }
    }

    /**
     * Get lightweight RPZ status
     */
    async getLightweightStatus() {
        try {
            const zoneExists = await fs.pathExists(this.lightweightZoneFile);
            let domainCount = 0;

            if (zoneExists) {
                const content = await fs.readFile(this.lightweightZoneFile, 'utf8');
                // Count CNAME records
                domainCount = (content.match(/IN CNAME \./g) || []).length;
            }

            return {
                enabled: zoneExists,
                domains: domainCount,
                zoneFile: this.lightweightZoneFile,
                size: zoneExists ? (await fs.stat(this.lightweightZoneFile)).size : 0
            };
        } catch (error) {
            return {
                enabled: false,
                domains: 0,
                error: error.message
            };
        }
    }
}

module.exports = new LightweightRPZService();