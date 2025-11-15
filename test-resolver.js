const fs = require('fs').promises;

async function testResolverStats() {
  try {
    console.log('Testing updated resolver statistics...');

    // Check query log
    const queryLogPath = '/var/log/bind/query.log';
    const logContent = await fs.readFile(queryLogPath, 'utf8');
    const lines = logContent.split('\n').filter(line => line.trim());
    console.log('Query log lines:', lines.length);

    // Parse queries from last 24 hours
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    const queryTypes = {};
    let totalQueries = 0;

    lines.forEach(line => {
      const queryMatch = line.match(/(\d{2}-\w{3}-\d{4} \d{2}:\d{2}:\d{2}\.\d{3}) queries:\s+info:\s+.*?\(([^)]+)\):\s+query:\s+([^)]+)\s+(\w+)\s+\+.*?\(([^)]+)\)/);
      if (queryMatch) {
        const timestamp = new Date(queryMatch[1]).getTime();
        const domain = queryMatch[2];
        const queryType = queryMatch[4];

        if (timestamp > twentyFourHoursAgo) {
          totalQueries++;
          queryTypes[queryType] = (queryTypes[queryType] || 0) + 1;
        }
      }
    });

    console.log('Total queries in last 24 hours:', totalQueries);
    console.log('Query types:', queryTypes);

    // Test top domains
    const domainCounts = {};
    lines.forEach(line => {
      const queryMatch = line.match(/queries:\s+info:\s+.*?\(([^)]+)\):/);
      if (queryMatch) {
        const domain = queryMatch[1].toLowerCase();
        if (!domain.includes('dionipe.id') && !domain.includes('dionipe.net') && !domain.includes('in-addr.arpa')) {
          domainCounts[domain] = (domainCounts[domain] || 0) + 1;
        }
      }
    });

    const topDomains = Object.entries(domainCounts)
      .map(([domain, count]) => ({ domain, queries: count }))
      .sort((a, b) => b.queries - a.queries)
      .slice(0, 10);

    console.log('Top domains:', topDomains);

  } catch (error) {
    console.error('Error:', error.message);
  }
}

testResolverStats();