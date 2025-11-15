const fs = require('fs');
const path = require('path');
const readline = require('readline');

function isValidDomain(domain) {
    // Basic domain validation
    if (!domain || domain.length === 0 || domain.length > 253) {
        return false;
    }

    // Check if it's a valid domain format
    const domainRegex = /^[a-zA-Z0-9.*_-]+\.[a-zA-Z0-9.*_-]+(\.[a-zA-Z0-9.*_-]+)*$/;
    if (!domainRegex.test(domain)) {
        return false;
    }

    // Check each label length (parts separated by dots)
    const labels = domain.split('.');
    for (const label of labels) {
        // Skip empty labels
        if (label.length === 0) continue;

        // DNS labels can be up to 63 characters
        if (label.length > 63) {
            return false;
        }

        // Labels cannot start or end with hyphens
        if (label.startsWith('-') || label.endsWith('-')) {
            return false;
        }

        // Labels should not contain only asterisks
        if (/^\*+$/.test(label)) {
            return false;
        }
    }

    return true;
}

async function processDownloadedDomains() {
    const inputFiles = [
        '/opt/ndash/alsyundawy_blacklist.txt'
    ];

    const rpzZonesDir = '/opt/ndash/rpz-zones';

    // Clean up old zones
    if (fs.existsSync(rpzZonesDir)) {
        fs.rmSync(rpzZonesDir, { recursive: true, force: true });
    }
    fs.mkdirSync(rpzZonesDir, { recursive: true });

    console.log('Counting domains from downloaded files...');
    let totalDomains = 0;
    for (const file of inputFiles) {
        if (fs.existsSync(file)) {
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim());
            totalDomains += lines.length;
        }
    }
    console.log(`Found ${totalDomains} domains total`);

    // Define zones with different priorities
    const zones = [
        { name: 'rpz-high-priority', priority: 1, count: 0, stream: null },
        { name: 'rpz-medium-priority', priority: 2, count: 0, stream: null },
        { name: 'rpz-low-priority', priority: 3, count: 0, stream: null },
        { name: 'rpz-very-low-priority', priority: 4, count: 0, stream: null }
    ];

    const domainsPerZone = Math.ceil(totalDomains / zones.length);
    console.log(`Distributing ~${domainsPerZone} domains per zone`);

    // Create zone files and write headers
    for (const zone of zones) {
        const zoneFile = path.join(rpzZonesDir, `${zone.name}.db`);
        zone.stream = fs.createWriteStream(zoneFile);

        const serial = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '01';
        const header = `\$TTL 86400
@ IN SOA localhost. root.localhost. (
    ${serial} ; serial
    3600       ; refresh
    1800       ; retry
    604800     ; expire
    86400      ; minimum
)
@ IN NS localhost.

; RPZ zone: ${zone.name}
; Generated from alsyundawy blacklist
; Generated on ${new Date().toISOString()}
`;

        zone.stream.write(header);
    }

    // Process domains from all input files
    console.log('Processing domains...');
    let domainIndex = 0;
    let currentZoneIndex = 0;

    for (const inputFile of inputFiles) {
        if (!fs.existsSync(inputFile)) {
            console.log(`Warning: ${inputFile} not found, skipping...`);
            continue;
        }

        const rl = readline.createInterface({
            input: fs.createReadStream(inputFile),
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            const domain = line.trim();
            if (domain && isValidDomain(domain)) {
                // Determine which zone this domain goes to
                const zoneIndex = Math.floor(domainIndex / domainsPerZone);
                if (zoneIndex < zones.length) {
                    zones[zoneIndex].stream.write(`${domain} IN CNAME .\n`);
                    zones[zoneIndex].count++;
                }
                domainIndex++;

                // Progress reporting
                if (domainIndex % 100000 === 0) {
                    console.log(`Processed ${domainIndex} domains...`);
                }
            }
        }
    }

    // Close all streams
    console.log('Closing zone files...');
    for (const zone of zones) {
        zone.stream.end();
    }

    // Wait for streams to finish
    await Promise.all(zones.map(zone =>
        new Promise(resolve => zone.stream.on('finish', resolve))
    ));

    console.log('Zone files created:');
    zones.forEach(zone => {
        console.log(`  ${zone.name}: ${zone.count} domains`);
    });

    // Create configuration
    const rpzConfig = generateRPZConfig(zones);
    const configFile = path.join(rpzZonesDir, 'rpz-zones.conf');

    fs.writeFileSync(configFile, rpzConfig, 'utf8');
    console.log(`Created ${configFile}`);

    console.log('RPZ zones creation completed!');
}

function generateRPZConfig(zones) {
    let config = `# RPZ Zones Configuration
# Generated from alsyundawy blacklist

`;

    zones.forEach((zone, index) => {
        config += `zone "${zone.name}" {
    type master;
    file "/opt/ndash/rpz-zones/${zone.name}.db";
    allow-query { any; };
    allow-transfer { any; };
};

`;
    });

    config += `# Response Policy Zone configuration
options {
    response-policy {
`;

    zones.forEach((zone, index) => {
        const priority = zone.priority;
        config += `        zone "${zone.name}" policy given;\n`;
    });

    config += `    };
};
`;

    return config;
}

// Run the processing
processDownloadedDomains().catch(console.error);