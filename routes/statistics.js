const express = require('express');
const router = express.Router();
const bindService = require('../services/bindService');
const moment = require('moment');
const { activities } = require('../data/storage');

// GET /statistics - Main statistics page
router.get('/', async (req, res) => {
    try {
        const data = await getStatisticsData();
        res.render('statistics/index', {
            title: 'Statistics - NDash',
            ...data,
            moment
        });
    } catch (error) {
        console.error('Error loading statistics page:', error);
        res.render('error', {
            title: 'Error',
            message: 'Failed to load statistics',
            error: error
        });
    }
});

// GET /statistics/api/data - API endpoint for real-time stats
router.get('/api/data', async (req, res) => {
    try {
        const data = await getStatisticsData();
        res.json({ success: true, data });
    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.json({ success: false, error: error.message });
    }
});

// Helper function to get all statistics data
async function getStatisticsData() {
    const zones = await bindService.listZones();
    
    // Calculate zone statistics
    const zoneStats = {
        total: zones.length,
        active: zones.filter(z => z.status === 'active').length,
        master: zones.filter(z => z.type === 'master').length,
        slave: zones.filter(z => z.type === 'slave').length,
        forward: zones.filter(z => !z.name.includes('in-addr.arpa')).length,
        reverse: zones.filter(z => z.name.includes('in-addr.arpa')).length
    };

    // Calculate record statistics
    let totalRecords = 0;
    const recordsByType = {};
    const recordsByZone = [];
    const topZones = [];

    for (const zone of zones) {
        try {
            const zoneData = await bindService.getZone(zone.name);
            const records = zoneData.records || [];
            const zoneRecordCount = records.length;
            totalRecords += zoneRecordCount;

            // Count by type
            records.forEach(record => {
                const type = record.type || 'OTHER';
                recordsByType[type] = (recordsByType[type] || 0) + 1;
            });

            // Zone-specific stats
            const typeBreakdown = {};
            records.forEach(record => {
                const type = record.type || 'OTHER';
                typeBreakdown[type] = (typeBreakdown[type] || 0) + 1;
            });

            recordsByZone.push({
                name: zone.name,
                total: zoneRecordCount,
                types: typeBreakdown,
                type: zone.type
            });

            topZones.push({
                name: zone.name,
                records: zoneRecordCount,
                type: zone.type
            });
        } catch (error) {
            console.error(`Error processing zone ${zone.name}:`, error.message);
        }
    }

    // Sort top zones by record count
    topZones.sort((a, b) => b.records - a.records);

    // Calculate record type percentages
    const recordTypeStats = Object.entries(recordsByType).map(([type, count]) => ({
        type,
        count,
        percentage: ((count / totalRecords) * 100).toFixed(1)
    })).sort((a, b) => b.count - a.count);

    // Activity statistics
    const activityStats = {
        total: activities.length,
        today: activities.filter(a => moment(a.timestamp).isSame(moment(), 'day')).length,
        thisWeek: activities.filter(a => moment(a.timestamp).isSame(moment(), 'week')).length,
        thisMonth: activities.filter(a => moment(a.timestamp).isSame(moment(), 'month')).length,
        recentActivities: activities.slice(0, 10)
    };

    // Activity by type
    const activityByType = {};
    activities.forEach(activity => {
        const type = activity.action.split(' ')[0]; // Get first word (Created, Modified, Deleted)
        activityByType[type] = (activityByType[type] || 0) + 1;
    });

    // Time-based statistics (last 7 days)
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
        const date = moment().subtract(i, 'days');
        const count = activities.filter(a => 
            moment(a.timestamp).isSame(date, 'day')
        ).length;
        last7Days.push({
            date: date.format('MMM DD'),
            count
        });
    }

    // Growth statistics
    const lastMonthZones = zones.filter(z => 
        z.createdAt && moment(z.createdAt).isAfter(moment().subtract(30, 'days'))
    ).length;

    const lastMonthRecords = activities.filter(a => 
        a.action.includes('Record') && 
        moment(a.timestamp).isAfter(moment().subtract(30, 'days'))
    ).length;

    // Top queried domains
    const topQueriedDomains = await getTopQueriedDomains();

    return {
        zoneStats,
        recordStats: {
            total: totalRecords,
            byType: recordTypeStats,
            byZone: recordsByZone
        },
        topZones: topZones.slice(0, 10),
        activityStats,
        activityByType,
        activityTimeline: last7Days,
        growth: {
            zonesLastMonth: lastMonthZones,
            recordsLastMonth: lastMonthRecords
        },
        topQueriedDomains
    };
}

// Helper function to parse query logs and get top queried domains
async function getTopQueriedDomains(limit = 10) {
    try {
        const fs = require('fs').promises;
        const path = require('path');
        
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
            // Example: 14-Nov-2025 10:30:15.123 queries: info: client @0x7f8b8c0d8e90 192.168.1.100#54321 (google.com): query: google.com IN A + (192.168.1.1)
            const queryMatch = line.match(/queries:\s+info:\s+.*?\(([^)]+)\):/);
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

// Helper function to get resolver statistics
async function getResolverStatistics() {
    try {
        const fs = require('fs').promises;
        const settingsUtil = require('../utils/settings');

        // Get resolver settings
        const settings = await settingsUtil.loadSettings();
        const resolverEnabled = settings.resolver?.enabled || false;

        if (!resolverEnabled) {
            return {
                enabled: false,
                message: 'DNS Resolver is currently disabled'
            };
        }

        // Query statistics from logs
        const queryStats = await getQueryStatistics();

        // Cache statistics (if available)
        const cacheStats = await getCacheStatistics();

        // Forwarder statistics
        const forwarderStats = await getForwarderStatistics();

        return {
            enabled: true,
            queryStats,
            cacheStats,
            forwarderStats,
            lastUpdated: new Date().toISOString()
        };
    } catch (error) {
        console.error('Error getting resolver statistics:', error);
        return {
            enabled: false,
            error: error.message
        };
    }
}

// Helper function to get query statistics
async function getQueryStatistics() {
    try {
        const fs = require('fs').promises;
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

        // Parse queries from last hour
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        const recentQueries = [];
        const queryTypes = {};

        lines.forEach(line => {
            // Parse BIND query log format
            const queryMatch = line.match(/(\d{2}-\w{3}-\d{4} \d{2}:\d{2}:\d{2}\.\d{3}) queries:\s+info:\s+.*?\(([^)]+)\):\s+query:\s+([^)]+)\s+(\w+)\s+\+.*?\(([^)]+)\)/);
            if (queryMatch) {
                const timestamp = new Date(queryMatch[1]).getTime();
                const domain = queryMatch[2];
                const queryType = queryMatch[4];
                const client = queryMatch[5];

                if (timestamp > oneHourAgo) {
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
        const queriesPerSecond = totalQueries / 3600; // Average over last hour

        return {
            totalQueries,
            queriesPerSecond: queriesPerSecond.toFixed(2),
            queryTypes,
            timeRange: 'Last hour'
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
        const fs = require('fs').promises;
        const statsContent = await fs.readFile(statsPath, 'utf8');

        // Parse cache statistics
        const cacheHits = statsContent.match(/Cache Hits\s+(\d+)/)?.[1] || 0;
        const cacheMisses = statsContent.match(/Cache Misses\s+(\d+)/)?.[1] || 0;
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
        const settingsUtil = require('../utils/settings');
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

module.exports = router;
