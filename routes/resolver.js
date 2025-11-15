const express = require('express');
const router = express.Router();
const bindService = require('../services/bindService');
const moment = require('moment');
const fs = require('fs').promises;
const settingsUtil = require('../utils/settings');

// GET /resolver - DNS Resolver Statistics page
router.get('/', async (req, res) => {
    try {
        const data = await getResolverStatisticsData();
        res.render('resolver/index', {
            title: 'DNS Resolver Statistics - NDash',
            ...data,
            moment
        });
    } catch (error) {
        console.error('Error loading resolver statistics page:', error);
        res.render('error', {
            title: 'Error',
            message: 'Failed to load resolver statistics',
            error: error
        });
    }
});

// GET /resolver/api/data - API endpoint for real-time resolver stats
router.get('/api/data', async (req, res) => {
    try {
        const data = await getResolverStatisticsData();
        res.json({ success: true, data });
    } catch (error) {
        console.error('Error fetching resolver statistics:', error);
        res.json({ success: false, error: error.message });
    }
});

// Helper function to get resolver statistics data
async function getResolverStatisticsData() {
    try {
        // Get resolver settings
        const settings = await settingsUtil.loadSettings();
        const resolverEnabled = settings.resolver?.enabled || false;

        if (!resolverEnabled) {
            return {
                resolverEnabled: false,
                message: 'DNS Resolver is currently disabled',
                resolverStats: {
                    enabled: false,
                    message: 'DNS Resolver is currently disabled'
                }
            };
        }

        // Query statistics from logs
        const queryStats = await getQueryStatistics();

        // Cache statistics (if available)
        const cacheStats = await getCacheStatistics();

        // Forwarder statistics
        const forwarderStats = await getForwarderStatistics();

        // Response time statistics
        const responseStats = await getResponseTimeStatistics();

        // Top queried domains
        const topQueriedDomains = await getTopQueriedDomains();

        // Adblock statistics
        const adblockStats = await getAdblockStatistics();

        // Encrypted DNS status
        const encryptedDnsStats = await getEncryptedDnsStatistics();

        // Resolver configuration
        const resolverConfig = {
            enabled: settings.resolver.enabled,
            forwarders: settings.resolver.forwarders || [],
            queryLogging: settings.resolver.queryLogging || false,
            cacheSize: settings.resolver.cacheSize || '256M',
            dnssecValidation: settings.resolver.dnssecValidation || true,
            adblock: settings.resolver.adblock || { enabled: false },
            doh: settings.resolver.doh || { enabled: false },
            dot: settings.resolver.dot || { enabled: false }
        };

        const resolverStats = {
            enabled: true,
            queryStats,
            cacheStats,
            forwarderStats,
            responseStats,
            adblockStats,
            encryptedDnsStats,
            lastUpdated: new Date().toISOString()
        };

        return {
            resolverEnabled: true,
            resolverStats,
            resolverConfig,
            topQueriedDomains
        };
    } catch (error) {
        console.error('Error getting resolver statistics data:', error);
        return {
            resolverEnabled: false,
            error: error.message
        };
    }
}

// Helper function to get query statistics
async function getQueryStatistics() {
    try {
        const queryLogPath = '/var/log/bind/query.log';

        // Check if query log exists
        try {
            await fs.access(queryLogPath);
        } catch (error) {
            return {
                totalQueries: 0,
                queriesPerSecond: 0,
                queryTypes: {},
                timeRange: 'No query logs available'
            };
        }

        // Read query log
        const logContent = await fs.readFile(queryLogPath, 'utf8');
        const lines = logContent.split('\n').filter(line => line.trim());

        // Parse queries from last 24 hours (more reasonable timeframe)
        const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
        const recentQueries = [];
        const queryTypes = {};

        lines.forEach(line => {
            // Parse BIND query log format
            // Example: 14-Nov-2025 22:28:32.821 client @0x7f776aae7000 192.168.203.254#20984 (cloud.mikrotik.com): query: cloud.mikrotik.com IN A + (192.168.203.11)
            const queryMatch = line.match(/(\d{2}-\w{3}-\d{4} \d{2}:\d{2}:\d{2}\.\d{3}) client\s+@\w+\s+([^#]+)#\d+\s+\(([^)]+)\):\s+query:\s+([^\s]+)\s+(\w+)\s+(\w+)\s+\+(\s*\([^)]+\))?/);
            if (queryMatch) {
                const timestamp = new Date(queryMatch[1]).getTime();
                const client = queryMatch[2];
                const domain = queryMatch[4]; // Use the domain after "query:"
                const queryType = queryMatch[6]; // A, AAAA, etc.

                if (timestamp > twentyFourHoursAgo) {
                    recentQueries.push({
                        timestamp,
                        domain,
                        type: queryType,
                        client
                    });

                    // Count query types
                    queryTypes[queryType] = (queryTypes[queryType] || 0) + 1;
                }
            }
        });

        const totalQueries = recentQueries.length;
        const queriesPerSecond = totalQueries / (24 * 3600); // Average over last 24 hours

        return {
            totalQueries,
            queriesPerSecond: queriesPerSecond.toFixed(3),
            queryTypes,
            timeRange: 'Last 24 hours'
        };
    } catch (error) {
        console.error('Error getting query statistics:', error);
        return {
            totalQueries: 0,
            queriesPerSecond: 0,
            queryTypes: {},
            timeRange: 'Error reading logs'
        };
    }
}

// Helper function to get cache statistics
async function getCacheStatistics() {
    try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);

        // Get cache statistics from rndc
        const { stdout } = await execPromise('rndc stats');
        const statsPath = '/var/cache/bind/named.stats';

        // Read stats file
        const statsContent = await fs.readFile(statsPath, 'utf8');

        // Parse cache statistics - find the last complete cache statistics section
        const cacheSections = statsContent.split('++ Cache Statistics ++');
        const lastCacheSection = cacheSections[cacheSections.length - 1];

        // Extract from the default view in the last section
        const defaultViewStart = lastCacheSection.indexOf('[View: default]');
        const defaultViewStats = defaultViewStart !== -1 ? lastCacheSection.substring(defaultViewStart) : lastCacheSection;

        const cacheHits = defaultViewStats.match(/cache hits\s+(\d+)/)?.[1] || 0;
        const cacheMisses = defaultViewStats.match(/cache misses\s+(\d+)/)?.[1] || 0;
        const totalCacheOps = parseInt(cacheHits) + parseInt(cacheMisses);
        const cacheHitRate = totalCacheOps > 0 ? ((parseInt(cacheHits) / totalCacheOps) * 100).toFixed(1) : 0;

        return {
            cacheHits: parseInt(cacheHits),
            cacheMisses: parseInt(cacheMisses),
            cacheHitRate: `${cacheHitRate}%`,
            totalCacheOperations: totalCacheOps
        };
    } catch (error) {
        console.error('Error getting cache statistics:', error);
        return {
            cacheHits: 0,
            cacheMisses: 0,
            cacheHitRate: '0%',
            totalCacheOperations: 0,
            error: 'Cache statistics not available'
        };
    }
}

// Helper function to get forwarder statistics
async function getForwarderStatistics() {
    try {
        const settings = await settingsUtil.loadSettings();

        const forwarders = settings.resolver?.forwarders || [];

        return {
            configuredForwarders: forwarders.length,
            forwarders: forwarders,
            note: 'Detailed forwarder usage requires additional logging configuration'
        };
    } catch (error) {
        console.error('Error getting forwarder statistics:', error);
        return {
            configuredForwarders: 0,
            forwarders: [],
            error: error.message
        };
    }
}

// Helper function to get response time statistics
async function getResponseTimeStatistics() {
    try {
        const queryLogPath = '/var/log/bind/query.log';

        // Check if query log exists
        try {
            await fs.access(queryLogPath);
        } catch (error) {
            return {
                averageResponseTime: 0,
                minResponseTime: 0,
                maxResponseTime: 0,
                responseTimeDistribution: {}
            };
        }

        // Read query log
        const logContent = await fs.readFile(queryLogPath, 'utf8');
        const lines = logContent.split('\n').filter(line => line.trim());

        // Parse response times from logs (this is simplified - actual parsing would be more complex)
        const responseTimes = [];

        lines.forEach(line => {
            // Look for response time information in logs
            // This is a simplified example - actual BIND logs may have different format
            const timeMatch = line.match(/(\d+)ms/);
            if (timeMatch) {
                const responseTime = parseInt(timeMatch[1]);
                if (responseTime > 0 && responseTime < 10000) { // Reasonable bounds
                    responseTimes.push(responseTime);
                }
            }
        });

        if (responseTimes.length === 0) {
            return {
                averageResponseTime: 0,
                minResponseTime: 0,
                maxResponseTime: 0,
                responseTimeDistribution: {},
                note: 'Response time data not available in current log format'
            };
        }

        const averageResponseTime = (responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length).toFixed(2);
        const minResponseTime = Math.min(...responseTimes);
        const maxResponseTime = Math.max(...responseTimes);

        // Create response time distribution
        const distribution = {};
        responseTimes.forEach(time => {
            const bucket = Math.floor(time / 100) * 100; // Group by 100ms buckets
            distribution[`${bucket}-${bucket + 99}ms`] = (distribution[`${bucket}-${bucket + 99}ms`] || 0) + 1;
        });

        return {
            averageResponseTime: `${averageResponseTime}ms`,
            minResponseTime: `${minResponseTime}ms`,
            maxResponseTime: `${maxResponseTime}ms`,
            responseTimeDistribution: distribution,
            sampleSize: responseTimes.length
        };
    } catch (error) {
        console.error('Error getting response time statistics:', error);
        return {
            averageResponseTime: '0ms',
            minResponseTime: '0ms',
            maxResponseTime: '0ms',
            responseTimeDistribution: {},
            error: error.message
        };
    }
}

// Helper function to parse query logs and get top queried domains
async function getTopQueriedDomains(limit = 20) {
    try {
        const queryLogPath = '/var/log/bind/query.log';

        // Check if query log exists
        try {
            await fs.access(queryLogPath);
        } catch (error) {
            return []; // Return empty array if log doesn't exist yet
        }

        // Read query log
        const logContent = await fs.readFile(queryLogPath, 'utf8');
        const lines = logContent.split('\n').filter(line => line.trim());

        // Parse queries from log
        const domainCounts = {};

        lines.forEach(line => {
            // Parse BIND query log format
            // Example: 14-Nov-2025 22:28:32.821 client @0x7f776aae7000 192.168.203.254#20984 (cloud.mikrotik.com): query: cloud.mikrotik.com IN A + (192.168.203.11)
            const queryMatch = line.match(/client\s+@\w+\s+[^#]+#\d+\s+\(([^)]+)\):/);
            if (queryMatch) {
                const domain = queryMatch[1].toLowerCase();
                // Skip our own zones
                if (!domain.includes('dionipe.id') && !domain.includes('dionipe.net') && !domain.includes('in-addr.arpa')) {
                    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
                }
            }
        });

        // Convert to array and sort by count
        const topDomains = Object.entries(domainCounts)
            .map(([domain, count]) => ({ domain, queries: count }))
            .sort((a, b) => b.queries - a.queries)
            .slice(0, limit);

        return topDomains;
    } catch (error) {
        console.error('Error parsing query logs:', error);
        return [];
    }
}

// Helper function to get adblock statistics
async function getAdblockStatistics() {
    try {
        const settings = await settingsUtil.loadSettings();
        const adblockEnabled = settings.resolver?.adblock?.enabled || false;

        if (!adblockEnabled) {
            return {
                enabled: false,
                blockedDomains: 0,
                lastUpdated: null
            };
        }

        const zoneFile = '/etc/bind/zones/adblock.db';
        
        try {
            const zoneContent = await fs.readFile(zoneFile, 'utf8');
            const lines = zoneContent.split('\n');
            
            // Count blocked domains (lines with CNAME records)
            const blockedDomains = lines.filter(line => 
                line.trim() && 
                !line.startsWith('$') && 
                !line.startsWith('@') && 
                !line.startsWith(';') &&
                line.includes('IN CNAME')
            ).length;

            // Get file modification time
            const stats = await fs.stat(zoneFile);
            
            return {
                enabled: true,
                blockedDomains,
                lastUpdated: stats.mtime.toISOString(),
                redirectTo: settings.resolver.adblock.redirectTo || '0.0.0.0'
            };
        } catch (error) {
            return {
                enabled: true,
                blockedDomains: 0,
                lastUpdated: null,
                error: 'Zone file not found or unreadable'
            };
        }
    } catch (error) {
        console.error('Error getting adblock statistics:', error);
        return {
            enabled: false,
            blockedDomains: 0,
            lastUpdated: null,
            error: error.message
        };
    }
}

// Helper function to get encrypted DNS statistics
async function getEncryptedDnsStatistics() {
    try {
        const encryptedDnsService = require('../services/encryptedDnsService');
        const status = encryptedDnsService.getStatus();

        return {
            doh: {
                enabled: status.doh.running,
                port: status.doh.port
            },
            dot: {
                enabled: status.dot.running,
                port: status.dot.port
            }
        };
    } catch (error) {
        console.error('Error getting encrypted DNS statistics:', error);
        return {
            doh: { enabled: false, port: null },
            dot: { enabled: false, port: null },
            error: error.message
        };
    }
}

module.exports = router;