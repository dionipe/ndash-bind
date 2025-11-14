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
            enableResolver, queryLogging, dnssecValidation, cacheSize, forwarders
        } = req.body;
        
        console.log('Received POST data:', req.body);
        
        // Update zone settings
        const zoneUpdates = {
            autoReload: autoReload === 'on',
            validateBeforeReload: validateBeforeReload === 'on',
            backupEnabled: backupEnabled === 'on',
            autoGeneratePTR: autoGeneratePTR === 'on'
        };
        
        // Update resolver settings
        const resolverUpdates = {
            enabled: enableResolver === 'on',
            queryLogging: queryLogging === 'on',
            dnssecValidation: dnssecValidation === 'on',
            cacheSize: cacheSize || '256M'
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

module.exports = router;
