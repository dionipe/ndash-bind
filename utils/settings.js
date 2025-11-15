const fs = require('fs-extra');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../data/settings.json');

// Default settings
const DEFAULT_SETTINGS = {
    zones: {
        autoReload: true,
        validateBeforeReload: true,
        backupEnabled: true,
        autoGeneratePTR: true
    },
    bind: {
        version: 'Bind 9.18.28',
        configPath: '/etc/bind',
        zonesPath: '/etc/bind/zones',
        namedConfLocal: '/etc/bind/named.conf.local',
        namedConfOptions: '/etc/bind/named.conf.options'
    },
    resolver: {
        enabled: false,
        forwarders: ['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1'],
        queryLogging: false,
        cacheSize: '256M',
        dnssecValidation: true,
        adblock: {
            enabled: false,
            blocklistUrls: ['https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts'],
            customDomains: [],
            redirectTo: '0.0.0.0',
            wildcardEnabled: false,
            wildcardDomains: []
        },
        doh: {
            enabled: false,
            port: 443,
            certPath: '/etc/ssl/certs/ndash.crt',
            keyPath: '/etc/ssl/private/ndash.key'
        },
        dot: {
            enabled: false,
            port: 853,
            certPath: '/etc/ssl/certs/ndash.crt',
            keyPath: '/etc/ssl/private/ndash.key'
        }
    }
};

/**
 * Load settings from file or return defaults
 */
async function loadSettings() {
    try {
        await fs.ensureFile(SETTINGS_FILE);
        const fileContent = await fs.readFile(SETTINGS_FILE, 'utf8');
        
        if (!fileContent || fileContent.trim() === '') {
            // File is empty, save and return defaults
            await saveSettings(DEFAULT_SETTINGS);
            return DEFAULT_SETTINGS;
        }
        
        const settings = JSON.parse(fileContent);
        return { ...DEFAULT_SETTINGS, ...settings };
    } catch (error) {
        console.warn('Failed to load settings, using defaults:', error.message);
        return DEFAULT_SETTINGS;
    }
}

/**
 * Save settings to file
 */
async function saveSettings(settings) {
    try {
        await fs.ensureDir(path.dirname(SETTINGS_FILE));
        await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
        console.log('✓ Settings saved successfully');
        return true;
    } catch (error) {
        console.error('✗ Failed to save settings:', error.message);
        throw error;
    }
}

/**
 * Update specific settings
 */
async function updateSettings(updates) {
    const currentSettings = await loadSettings();
    const newSettings = {
        ...currentSettings,
        zones: {
            ...currentSettings.zones,
            ...updates.zones
        },
        bind: {
            ...currentSettings.bind,
            ...updates.bind
        },
        resolver: {
            ...currentSettings.resolver,
            ...updates.resolver
        }
    };
    await saveSettings(newSettings);
    return newSettings;
}

/**
 * Get a specific setting value
 */
async function getSetting(category, key) {
    const settings = await loadSettings();
    return settings[category] ? settings[category][key] : undefined;
}

module.exports = {
    loadSettings,
    saveSettings,
    updateSettings,
    getSetting,
    DEFAULT_SETTINGS
};
