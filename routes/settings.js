const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const settingsUtil = require('../utils/settings');

// Get settings page
router.get('/', async (req, res) => {
    try {
        // Load current settings
        const settings = await settingsUtil.loadSettings();
        
        // Add server info
        settings.server = {
            port: 3000,
            nodeVersion: process.version,
            platform: process.platform,
            uptime: Math.floor(process.uptime()),
        };

        // Get actual Bind version
        try {
            const { exec } = require('child_process');
            const util = require('util');
            const execPromise = util.promisify(exec);
            const { stdout: versionOut } = await execPromise('named -v');
            settings.bind.version = versionOut.split('\n')[0];
        } catch (error) {
            console.warn('Could not get BIND version:', error.message);
            settings.bind.version = 'Unknown';
        }

        res.render('settings/index', {
            title: 'Settings',
            settings,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading settings:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load settings: ' + error.message
        });
    }
});

// Update settings
router.post('/', async (req, res) => {
    try {
        const { 
            autoReload, validateBeforeReload, backupEnabled, autoGeneratePTR,
            enableResolver, queryLogging, dnssecValidation, cacheSize, forwarders,
            enableAdblock, adblockUrls, adblockRedirect, customAdblockDomains,
            enableWildcardAdblock, wildcardAdblockDomains,
            enableHageziPro, enableHageziTif, enableHageziFake, enableHageziPopup, enableHageziTlds,
            enableDoH, dohPort, dohCertPath, dohKeyPath,
            enableDoT, dotPort, dotCertPath, dotKeyPath
        } = req.body;
        
        console.log('Received POST data:', req.body);
        
        // Load current settings to preserve values that weren't sent
        const currentSettings = await settingsUtil.loadSettings();
        
        // Update zone settings
        const zoneUpdates = {
            autoReload: autoReload !== undefined ? autoReload === 'on' : currentSettings.zones?.autoReload || false,
            validateBeforeReload: validateBeforeReload !== undefined ? validateBeforeReload === 'on' : currentSettings.zones?.validateBeforeReload || false,
            backupEnabled: backupEnabled !== undefined ? backupEnabled === 'on' : currentSettings.zones?.backupEnabled || false,
            autoGeneratePTR: autoGeneratePTR !== undefined ? autoGeneratePTR === 'on' : currentSettings.zones?.autoGeneratePTR || false
        };
        
        // Update resolver settings
        const resolverUpdates = {
            enabled: enableResolver !== undefined ? enableResolver === 'on' : currentSettings.resolver?.enabled || false,
            queryLogging: queryLogging !== undefined ? queryLogging === 'on' : currentSettings.resolver?.queryLogging || false,
            dnssecValidation: dnssecValidation !== undefined ? dnssecValidation === 'on' : currentSettings.resolver?.dnssecValidation || false,
            cacheSize: cacheSize || currentSettings.resolver?.cacheSize || '256M',
            adblock: {
                enabled: enableAdblock !== undefined ? enableAdblock === 'on' : currentSettings.resolver?.adblock?.enabled || false,
                blocklistUrls: (() => {
                    // Start with base blocklists
                    let urls = [];
                    
                    // Add traditional blocklists if provided
                    if (adblockUrls) {
                        urls = urls.concat(adblockUrls.split('\n').map(url => url.trim()).filter(url => url));
                    } else if (currentSettings.resolver?.adblock?.blocklistUrls) {
                        // Filter out hagezi URLs from existing list to rebuild
                        urls = currentSettings.resolver.adblock.blocklistUrls.filter(url => 
                            !url.includes('hagezi/dns-blocklists')
                        );
                    }
                    
                    // Add hagezi blocklists based on toggles
                    const hageziUrls = {
                        pro: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/rpz/pro.txt',
                        tif: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/rpz/tif.txt',
                        fake: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/rpz/fake.txt',
                        popup: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/rpz/popupads.txt',
                        tlds: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/rpz/spam-tlds-rpz.txt'
                    };
                    
                    if (enableHageziPro === 'on') urls.push(hageziUrls.pro);
                    if (enableHageziTif === 'on') urls.push(hageziUrls.tif);
                    if (enableHageziFake === 'on') urls.push(hageziUrls.fake);
                    if (enableHageziPopup === 'on') urls.push(hageziUrls.popup);
                    if (enableHageziTlds === 'on') urls.push(hageziUrls.tlds);
                    
                    // Ensure we have at least one URL
                    if (urls.length === 0) {
                        urls.push('https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts');
                    }
                    
                    return urls;
                })(),
                redirectTo: adblockRedirect || currentSettings.resolver?.adblock?.redirectTo || '0.0.0.0',
                customDomains: customAdblockDomains ? customAdblockDomains.split('\n').map(d => d.trim()).filter(d => d) : currentSettings.resolver?.adblock?.customDomains || [],
                wildcardEnabled: enableWildcardAdblock !== undefined ? enableWildcardAdblock === 'on' : currentSettings.resolver?.adblock?.wildcardEnabled || false,
                wildcardDomains: wildcardAdblockDomains ? wildcardAdblockDomains.split('\n').map(d => d.trim()).filter(d => d) : currentSettings.resolver?.adblock?.wildcardDomains || []
            },
            doh: {
                enabled: enableDoH !== undefined ? enableDoH === 'on' : currentSettings.resolver?.doh?.enabled || false,
                port: parseInt(dohPort) || currentSettings.resolver?.doh?.port || 443,
                certPath: dohCertPath || currentSettings.resolver?.doh?.certPath || '/etc/ssl/certs/doh.crt',
                keyPath: dohKeyPath || currentSettings.resolver?.doh?.keyPath || '/etc/ssl/private/doh.key'
            },
            dot: {
                enabled: enableDoT !== undefined ? enableDoT === 'on' : currentSettings.resolver?.dot?.enabled || false,
                port: parseInt(dotPort) || currentSettings.resolver?.dot?.port || 853,
                certPath: dotCertPath || currentSettings.resolver?.dot?.certPath || '/etc/ssl/certs/dot.crt',
                keyPath: dotKeyPath || currentSettings.resolver?.dot?.keyPath || '/etc/ssl/private/dot.key'
            }
        };
        
        // Handle forwarders (comma-separated string to array)
        if (forwarders) {
            resolverUpdates.forwarders = forwarders.split(',').map(f => f.trim()).filter(f => f);
        }
        
        const updates = {
            zones: zoneUpdates,
            resolver: resolverUpdates
        };
        
        await settingsUtil.updateSettings(updates);
        
        // Apply resolver configuration if enabled/disabled
        const bindService = require('../services/bindService');
        if (enableResolver === 'on') {
            await bindService.enableResolver(resolverUpdates);
        } else {
            await bindService.disableResolver();
        }
        
        console.log('✓ Settings updated:', updates);
        res.redirect('/settings?success=' + encodeURIComponent('Settings updated successfully'));
    } catch (error) {
        console.error('Error updating settings:', error);
        res.redirect('/settings?error=' + encodeURIComponent(error.message));
    }
});

// Get Bind status
router.get('/status', async (req, res) => {
    try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        
        // Get Bind status
        const { stdout: statusOut } = await execPromise('systemctl is-active named 2>/dev/null || systemctl is-active bind9');
        const isRunning = statusOut.trim() === 'active';
        
        // Get Bind version
        const { stdout: versionOut } = await execPromise('named -v');
        const version = versionOut.split('\n')[0];
        
        // Get rndc status
        const { stdout: rndcOut } = await execPromise('rndc status 2>&1');
        
        res.json({
            success: true,
            status: isRunning ? 'running' : 'stopped',
            version,
            rndcStatus: rndcOut
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Generate SSL Certificate
router.post('/generate-ssl', async (req, res) => {
    try {
        const sslGenerator = require('../utils/sslGenerator');

        // Check if certificates already exist
        const certStatus = await sslGenerator.checkCertificateExists();

        if (certStatus.certExists && certStatus.keyExists) {
            return res.json({
                success: false,
                message: 'SSL certificates already exist. Delete existing certificates first if you want to regenerate them.'
            });
        }

        // Generate new certificates
        const result = await sslGenerator.generateSelfSignedCertificate({
            commonName: req.body.commonName || 'localhost',
            organizationName: req.body.organizationName || 'NDash DNS Server',
            countryCode: req.body.countryCode || 'US',
            validityDays: parseInt(req.body.validityDays) || 365
        });

        res.json({
            success: true,
            message: result.message,
            certPath: result.certPath,
            keyPath: result.keyPath
        });

    } catch (error) {
        console.error('SSL certificate generation error:', error);
        res.json({
            success: false,
            message: `Failed to generate SSL certificate: ${error.message}`
        });
    }
});

// Get SSL Certificate Info
router.get('/ssl-info', async (req, res) => {
    try {
        const sslGenerator = require('../utils/sslGenerator');

        const certStatus = await sslGenerator.checkCertificateExists();
        const certInfo = certStatus.certExists ? await sslGenerator.getCertificateInfo() : null;

        res.json({
            certExists: certStatus.certExists,
            keyExists: certStatus.keyExists,
            certPath: certStatus.certPath,
            keyPath: certStatus.keyPath,
            certInfo: certInfo
        });

    } catch (error) {
        console.error('SSL info error:', error);
        res.json({
            error: error.message
        });
    }
});

// Delete SSL Certificates
router.post('/delete-ssl', async (req, res) => {
    try {
        const sslGenerator = require('../utils/sslGenerator');
        const fs = require('fs-extra');

        // Check if certificates exist
        const certStatus = await sslGenerator.checkCertificateExists();

        if (!certStatus.certExists && !certStatus.keyExists) {
            return res.json({
                success: false,
                message: 'No SSL certificates found to delete.'
            });
        }

        // Delete certificate files
        const deleted = [];
        if (certStatus.certExists) {
            await fs.remove(certStatus.certPath);
            deleted.push('certificate');
        }
        if (certStatus.keyExists) {
            await fs.remove(certStatus.keyPath);
            deleted.push('private key');
        }

        res.json({
            success: true,
            message: `SSL ${deleted.join(' and ')} deleted successfully. DoH and DoT services will be disabled.`
        });

    } catch (error) {
        console.error('SSL certificate deletion error:', error);
        res.json({
            success: false,
            message: `Failed to delete SSL certificates: ${error.message}`
        });
    }
});

module.exports = router;
