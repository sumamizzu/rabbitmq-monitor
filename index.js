require('dotenv').config();
const chalk = require('chalk');
const Table = require('cli-table3');
const moment = require('moment');
const ora = require('ora');
const amqp = require('amqplib');
const axios = require('axios');
const readline = require('readline');

// Configuration
const config = {
    rabbitMQ: {
        host: process.env.RABBITMQ_HOST || 'localhost',
        httpPort: process.env.RABBITMQ_HTTP_PORT || 15672,
        amqpPort: process.env.RABBITMQ_AMQP_PORT || 5672,
        adminUser: process.env.RABBITMQ_ADMIN_USER || 'guest',
        adminPassword: process.env.RABBITMQ_ADMIN_PASSWORD || 'guest',
    },
    display: {
        maxMessages: parseInt(process.env.MAX_MESSAGES_DISPLAY) || 50,
        refreshInterval: parseInt(process.env.REFRESH_INTERVAL) || 2000,
        showConnections: process.env.SHOW_CONNECTIONS !== 'false',
        showMessages: process.env.SHOW_MESSAGES !== 'false',
        showQueues: process.env.SHOW_QUEUES !== 'false',
        showStatistics: process.env.SHOW_STATISTICS !== 'false',
    }
};

// State
const state = {
    messages: [],
    connections: [],
    queues: [],
    vhosts: [],
    monitoringVHost: null, // null = not monitoring, string = vhost name
    statistics: {
        totalMessages: 0,
        startTime: Date.now(),
        messagesByVHost: {},
        messagesByRoutingKey: {}
    }
};

// API Client
const apiClient = axios.create({
    baseURL: `http://${config.rabbitMQ.host}:${config.rabbitMQ.httpPort}/api`,
    auth: {
        username: config.rabbitMQ.adminUser,
        password: config.rabbitMQ.adminPassword
    }
});

// AMQP Connection (single vhost monitoring)
let amqpConnection = null;
let amqpChannel = null;

// Input state for getInput
let resolveGetInput = null;
let inputBuffer = '';

// Clear screen and print header
function printHeader() {
    console.clear();
    console.log(chalk.bold.bgHex('#3c3c3c').white(' '.repeat(35) + 'MONITOR CONNESSIONI PER  ') + chalk.bold.bgHex('#3c3c3c').hex('#ff6600')('Rabbit') + chalk.bold.bgHex('#3c3c3c').white('MQ'+' '.repeat(35)));
    console.log();
}

// Print statistics
function printStatistics() {
    //if (!config.display.showStatistics) return;

    const uptime = moment.duration(Date.now() - state.statistics.startTime).locale('it').humanize();
    
    console.log(chalk.bold.bgCyan(' Statistiche '));
    //console.log(chalk.gray('─'.repeat(103)));
    
    const statsTable = new Table({
        //head: ['Metrica', 'Valore'],
        colWidths: [40, 40],
        style: {
            head: ['cyan'],
            border: ['gray']
        }
    });

    statsTable.push(
        ['VHosts Disponibili', chalk.cyan(state.vhosts.length) ],
        ['Totale Code', chalk.cyan(state.queues.length) ],
        ['Durata sessione', chalk.cyan(uptime) ]
    );

    if(state.monitoringVHost){
        statsTable.push(
            ['Totale Messaggi Intercettati', chalk.cyan(state.statistics.totalMessages) ],
            ['Connessioni Attive', chalk.cyan(state.connections.length) ],
            ['Messaggi in Memoria', chalk.cyan(state.messages.length) ]
        );
    }

    console.log(statsTable.toString());
    console.log();
}

// Print connections
function printConnections() {
    if (!config.display.showConnections || state.connections.length === 0) return;

    console.log(chalk.bold.bgHex("#870087")(' Connessioni attive '));
    //console.log(chalk.gray('─'.repeat(103)));

    const connTable = new Table({
        head: ['User', 'VHost', 'Protocollo', 'Peer(host:port)', 'Stato'],
        colWidths: [25, 20, 15, 23, 7],
        style: {
            head: ['green'],
            border: ['gray']
        }
    });

    state.connections.slice(0, 10).forEach(conn => {
        connTable.push([
            chalk.white(conn.user),
            chalk.yellow(conn.vhost),
            chalk.cyan(conn.protocol || 'N/A'),
            chalk.cyan(`${conn.peer_host}:${conn.peer_port}`),
            conn.state === 'running' ? chalk.green('●') : chalk.red('○')
        ]);
    });

    console.log(connTable.toString());
    console.log();
}

// Print queues
function printQueues() {
    if (!config.display.showQueues || state.queues.length === 0) return;

    console.log(chalk.bold.bgHex("#d75f00")(' Code '));
    //console.log(chalk.gray('─'.repeat(103)));

    const queueTable = new Table({
        head: ['Nome', 'VHost', 'Messaggi', 'Consumer'],
        colWidths: [35, 35, 10, 10],
        style: {
            head: ['blue'],
            border: ['gray']
        }
    });

    state.queues.slice(0, 10).forEach(queue => {
        queueTable.push([
            chalk.white(queue.name),
            chalk.yellow(queue.vhost),
            queue.messages > 0 ? chalk.white.bold.bgCyan(queue.messages) : chalk.cyan(queue.messages),
            chalk.cyan(queue.consumers || 0)
        ]);
    });

    console.log(queueTable.toString());
    console.log();
}

// Print messages
function printMessages() {
    if (!state.monitoringVHost) {
        // Show message that monitoring is not active
        console.log(chalk.yellow('  ℹ️  Monitoraggio messaggi non attivo'));
        console.log(chalk.gray('  Premi "m" per scegliere un vHost da monitorare'));
        console.log();
        return;
    }

    console.log(chalk.bold.bgHex("#c4a000")(' Messaggi Recenti ') + chalk.yellow(` (vHost: ${state.monitoringVHost})`));

    const msgTable = new Table({
        head: ['Ora', 'Routing Key', 'Exchange', 'Dimensione'],
        colWidths: [20, 35, 30, 14],
        style: {
            head: ['yellow'],
            border: ['gray']
        }
    });

    if (state.messages.length === 0) {
        msgTable.push([
            { colSpan: 4, content: chalk.gray('Nessun messaggio intercettato (in attesa...)'), hAlign: 'center' }
        ]);
    } else {
        state.messages.slice(0, 5).forEach(msg => {
            msgTable.push([
                chalk.gray(moment(msg.timestamp).format('HH:mm:ss')),
                chalk.cyan(msg.routingKey),
                chalk.magenta(msg.exchange || 'amq.default'),
                chalk.white(formatBytes(msg.size))
            ]);
        });
    }

    console.log(msgTable.toString());
    console.log();
}

// Print footer
function printFooter() {
    console.log(chalk.gray('─'.repeat(103)));
    
    if (state.monitoringVHost) {
        console.log(chalk.yellow('Comandi: ') + chalk.white('[s] Stop monitoring  [Ctrl+C] Exit'));
    } else {
        console.log(chalk.yellow('Comandi: ') + chalk.white('[m] Monitor vHost  [Ctrl+C] Exit'));
    }
    
    console.log(chalk.gray(`Ultimo aggiornamento: ${moment().format('HH:mm:ss')}`));
}

// Format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Fetch connections
async function fetchConnections() {
    try {
        const response = await apiClient.get('/connections');
        state.connections = response.data;
    } catch (error) {
        console.error(chalk.red('Error fetching connections:'), error.message);
    }
}

// Fetch queues
async function fetchQueues() {
    try {
        const response = await apiClient.get('/queues');
        state.queues = response.data;
    } catch (error) {
        console.error(chalk.red('Error fetching queues:'), error.message);
    }
}

// Fetch vhosts
async function fetchVHosts() {
    try {
        const response = await apiClient.get('/vhosts');
        state.vhosts = response.data;
    } catch (error) {
        console.error(chalk.red('Error fetching vhosts:'), error.message);
    }
}

// Start monitoring a specific vhost
async function startMonitoringVHost(vhost) {
    try {
        // Stop any existing monitoring
        await stopMonitoring();
        
        const vhostEncoded = encodeURIComponent(vhost);
        const amqpUrl = `amqp://${config.rabbitMQ.adminUser}:${config.rabbitMQ.adminPassword}@${config.rabbitMQ.host}:${config.rabbitMQ.amqpPort}/${vhostEncoded}`;
        
        amqpConnection = await amqp.connect(amqpUrl);
        amqpChannel = await amqpConnection.createChannel();

        const monitorQueue = await amqpChannel.assertQueue('', {
            exclusive: true,
            autoDelete: true
        });

        await amqpChannel.bindQueue(monitorQueue.queue, 'amq.topic', '#');

        amqpChannel.consume(monitorQueue.queue, (msg) => {
            if (msg) {
                handleMessage(msg, vhost);
                amqpChannel.ack(msg);
            }
        });

        state.monitoringVHost = vhost;
        state.messages = []; // Clear old messages
        
    } catch (error) {
        console.error(chalk.red(`Errore connessione a vhost "${vhost}":`), error.message);
        state.monitoringVHost = null;
    }
}

// Stop monitoring
async function stopMonitoring() {
    try {
        if (amqpChannel) {
            await amqpChannel.close();
            amqpChannel = null;
        }
        if (amqpConnection) {
            await amqpConnection.close();
            amqpConnection = null;
        }
        state.monitoringVHost = null;
        state.messages = [];
    } catch (error) {
        // Ignore errors during stop
    }
}

// Handle intercepted message
function handleMessage(msg, vhost = '/') {
    const messageData = {
        timestamp: Date.now(),
        vhost: vhost,
        exchange: msg.fields.exchange,
        routingKey: msg.fields.routingKey,
        size: msg.content.length,
        payload: null
    };

    try {
        const contentStr = msg.content.toString('utf8');
        if (contentStr.trim().startsWith('{') || contentStr.trim().startsWith('[')) {
            messageData.payload = JSON.parse(contentStr);
        } else {
            messageData.payload = contentStr;
        }
    } catch (e) {
        messageData.payload = msg.content.toString('base64');
    }

    state.messages.unshift(messageData);
    
    if (state.messages.length > config.display.maxMessages) {
        state.messages = state.messages.slice(0, config.display.maxMessages);
    }

    state.statistics.totalMessages++;
    
    if (!state.statistics.messagesByRoutingKey[messageData.routingKey]) {
        state.statistics.messagesByRoutingKey[messageData.routingKey] = 0;
    }
    state.statistics.messagesByRoutingKey[messageData.routingKey]++;
}

// Update display
async function updateDisplay() {
    await fetchConnections();
    await fetchQueues();
    await fetchVHosts();
    
    printHeader();
    printStatistics();
    printConnections();
    printQueues();
    printMessages();
    printFooter();
}

// Show vHost selection menu
async function showVHostMenu() {
    // Pause display updates
    if (displayInterval) {
        clearInterval(displayInterval);
    }
    
    console.clear();
    console.log(chalk.bold.cyan.inverse(' '.repeat(57)+'Seleziona vHost da monitorare'+' '.repeat(58)));
    
    if (state.vhosts.length === 0) {
        console.log(chalk.red('Nessun vHost disponibile'));
        console.log();
        console.log(chalk.gray('Premi un tasto per tornare...'));
        await waitForKey();
        restartDisplayUpdates();
        return;
    }
    
    // Create three-column layout
    const vhostsPerColumn = Math.ceil(state.vhosts.length / 3);
    const column1 = state.vhosts.slice(0, vhostsPerColumn);
    const column2 = state.vhosts.slice(vhostsPerColumn, vhostsPerColumn * 2);
    const column3 = state.vhosts.slice(vhostsPerColumn * 2);
    
    const vhostTable = new Table({
        chars: {
            'top-left': '' , 'top': '' , 'top-mid': '' , 'top-right': '' ,
            'left': '' , 'middle': '' , 'right': '' ,
            'bottom-left': '' , 'bottom': '' , 'bottom-mid': '' ,'bottom-right': '',
            'left-mid': '' , 'mid': '' , 'mid-mid': '' , 'right-mid': '' ,
        },
        head: ['#', 'Nome vHost', 'Code', '', '#', 'Nome vHost', 'Code', '', '#', 'Nome vHost', 'Code'],
        colWidths: [4, 34, 9, 2, 4, 34, 9, 2, 4, 34, 9],
        style: {
            head: ['cyan'],
            border: ['gray']
        }
    });
    
    for (let i = 0; i < vhostsPerColumn; i++) {
        const row = [];
        
        // First column
        if (column1[i]) {
            const vhost = column1[i];
            const index = i + 1;
            const queueCount = state.queues.filter(q => q.vhost === vhost.name).length;
            const coloring = queueCount ? chalk.bold.white : chalk.gray;
            row.push(
                coloring(index),
                coloring(vhost.name),
                coloring(queueCount + ' code')
            );
        } else {
            row.push('', '', '');
        }
        
        row.push(''); // Spacer
        
        // Second column
        if (column2[i]) {
            const vhost = column2[i];
            const index = vhostsPerColumn + i + 1;
            const queueCount = state.queues.filter(q => q.vhost === vhost.name).length;
            const coloring = queueCount ? chalk.bold.white : chalk.gray;
            row.push(
                coloring(index),
                coloring(vhost.name),
                coloring(queueCount + ' code')
            );
        } else {
            row.push('', '', '');
        }
        
        row.push(''); // Spacer
        
        // Third column
        if (column3[i]) {
            const vhost = column3[i];
            const index = vhostsPerColumn * 2 + i + 1;
            const queueCount = state.queues.filter(q => q.vhost === vhost.name).length;
            const coloring = queueCount ? chalk.bold.white : chalk.gray
            row.push(
                coloring(index),
                coloring(vhost.name),
                coloring(queueCount + ' code')
            );
        } else {
            row.push('', '', '');
        }
        
        vhostTable.push(row);
    }
    
    console.log(vhostTable.toString());
    console.log();
    console.log(chalk.gray('Inserisci il numero del vHost (0 per annullare): '));
    
    const choice = await getInput();
    const index = parseInt(choice) - 1;
    
    if (index >= 0 && index < state.vhosts.length) {
        const selectedVHost = state.vhosts[index].name;
        console.log(chalk.green(`\n✓ Avvio monitoraggio vHost: ${selectedVHost}`));
        await startMonitoringVHost(selectedVHost);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    restartDisplayUpdates();
}

// Wait for any key press
function waitForKey() {
    return new Promise(resolve => {
        process.stdin.once('data', () => resolve());
    });
}

// Get input from user
function getInput() {
    return new Promise(resolve => {
        resolveGetInput = resolve;
        inputBuffer = '';
    });
}

// Setup keyboard handler
function setupKeyboardHandler() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    
    // Resume stdin to receive keypresses
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    process.stdin.on('keypress', async (str, key) => {
        if (!key) return;
        
        // Handle Ctrl+C always
        if (key.ctrl && key.name === 'c') {
            await shutdown();
            return;
        }
        
        // If we're in input mode (getInput is active)
        if (resolveGetInput !== null) {
            if (key.name === 'return') {
                // Enter pressed - resolve the input
                const result = inputBuffer;
                const resolve = resolveGetInput;
                resolveGetInput = null;
                inputBuffer = '';
                resolve(result.trim());
            } else if (key.name === 'backspace') {
                // Handle backspace
                if (inputBuffer.length > 0) {
                    inputBuffer = inputBuffer.slice(0, -1);
                    process.stdout.write('\b \b');
                }
            } else if (str && !key.ctrl && !key.meta) {
                // Regular character
                inputBuffer += str;
                process.stdout.write(str);
            }
        } else {
            // Normal mode - handle commands
            if (key.name === 'm' && !state.monitoringVHost) {
                await showVHostMenu();
            } else if (key.name === 's' && state.monitoringVHost) {
                await stopMonitoring();
                await updateDisplay();
            }
        }
    });
}

let displayInterval = null;

function restartDisplayUpdates() {
    if (displayInterval) clearInterval(displayInterval);
    updateDisplay();
    displayInterval = setInterval(updateDisplay, config.display.refreshInterval);
}

// Main
async function main() {
    const spinner = ora('Connessione a RabbitMQ...').start();

    try {
        // Test connection
        await apiClient.get('/overview');
        spinner.succeed('✓ Connesso a RabbitMQ!');

        // Setup keyboard handler
        setupKeyboardHandler();
        
        // Initial display
        await updateDisplay();

        // Periodic updates
        displayInterval = setInterval(updateDisplay, config.display.refreshInterval);

    } catch (error) {
        spinner.fail('✗ Connessione a RabbitMQ fallita');
        console.error(chalk.red('Errore:'), error.message);
        console.log(chalk.yellow('\nVerifica che:'));
        console.log(chalk.gray('- RabbitMQ sia in esecuzione'));
        console.log(chalk.gray('- Management API sia accessibile sulla porta'), config.rabbitMQ.httpPort);
        console.log(chalk.gray('- Le credenziali in .env siano corrette'));
        process.exit(1);
    }
}

// Graceful shutdown
let isShuttingDown = false;

const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    console.log(chalk.yellow('\n\nChiusura in corso...'));
    
    try {
        if (displayInterval) clearInterval(displayInterval);
        await stopMonitoring();
        
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        
        process.stdin.pause();
        process.stdin.removeAllListeners('keypress');
        
        console.log(chalk.green('✓ Connessioni chiuse'));
        
        // Force exit after 1 second
        setTimeout(() => process.exit(0), 1000);
    } catch (error) {
        console.error(chalk.red('Errore durante la chiusura:'), error.message);
        process.exit(1);
    }
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// Start
main();
