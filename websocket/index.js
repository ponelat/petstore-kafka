require('dotenv').config() // Will load .env into process.env
const WebSocket = require('ws');
const { Kafka, logLevel } = require('kafkajs')
const { KafkaCache } = require('../lib')

const PORT = process.env.NODE_PORT || 3300
const BROKERS = process.env.BROKERS || ['localhost:9092']
const CLIENT_ID = 'websocket'

// Global state
let sockets = []
const socketsForLocation = {}
let consumer, producer

// ---------------------------------------------------------------
// Kafka
const kafka = new Kafka({
  logLevel: logLevel.INFO,
  brokers: BROKERS,
  clientId: CLIENT_ID,
})

const allTopics = [
  'pets.added',
  'pets.statusChanged',
  'adoptions.requested',
  'adoptions.statusChanged',
]


producer = kafka.producer()
producer.connect().then(console.log, console.error)

const cache = new KafkaCache({
  kafka,
  name: 'websocket-location-cache',
  topics: ['pets.added', 'adoptions.requested'],
  onCache: (old, log) => {
    if(!log.location) {
      return old
    }
    console.log(`Cacheing to disk: ${log.id} - ${log.location}`)
    return {location: log.location}
  }
})

subscribeToNew()

async function subscribeToNew () {
  const consumerGroup = 'websocket-new' // Add random suffix to make each instance unique??
  try {
	  const consumer = kafka.consumer({ groupId: consumerGroup})
	  await consumer.connect()
	  await consumer.subscribe({ topics: allTopics, fromBeginning: false }) 
	  await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        const log = JSON.parse(message.value.toString())
        const location = cache.get(log.id, {}).location || log.location
        if(!location) {
          console.error(`Log doesnt have location or cached location ${JSON.stringify(log)} ${topic}`)
          return 
        }
        eachSocketInLocation(location.toLowerCase(), (socket) => {
          socket.send(JSON.stringify({ type: 'kafka', topic, log }))
        })
	    },
	  })
  } catch(e) {
	  console.error(`[${consumerGroup}] ${e.message}`, e)   
  }
}

// ---------------------------------------------------------------
// Websocket server
const ws = new WebSocket.Server({
  host: '0.0.0.0',
  port: PORT,
}, (a) => {
  const address = ws._server.address()
  console.log('WebSocket listening at ', address.address, address.port, address.family)
});


ws.on('error', (e) => {
  console.error(e)
})

ws.on('connection', (socket) => {
  console.log('Connection recieved for Websocket')
  sockets.push(socket)

  socket.on('error', console.error)
  socket.on('message', (str) => {
	  try {
	    let msg = JSON.parse(str)
      
      if(!msg.location) {
		    socket.send(JSON.stringify({type: 'handshake.ack', ok: false, reasons: ['Missing .location field in handshake']}))
		    return 
      }
      const location = (msg.location+'').toLowerCase()
	    socketsForLocation[location] = socketsForLocation[location] || []
	    socketsForLocation[location].push(socket)
	    socket.send(JSON.stringify({type: 'handshake.ack', ok: true, reasons: [`Successfully subscribed to "${location}" changes`]}))
	    
    } catch(e) {
      console.error(e)
      socket.close()
    }

  })

  socket.on('close', function() {
    sockets = sockets.filter(s => s !== socket);
  })

})

function eachSocketInLocation(location, cb) {
  const sockets = socketsForLocation[location.toLowerCase()] || []
  if(!sockets.length) {
    return 
  }
  console.log(`Broadcasting for ${location}`)
  sockets.forEach(cb)
}
