require('dotenv').config() // Will load .env into process.env
const express = require('express')
const path = require('path')
const cors = require('cors')
const app = express()
const bodyParser = require('body-parser')
const uuid = require('uuid')
const morgan = require('morgan')
const { Kafka, logLevel } = require('kafkajs')
const { FlatDB } = require('../lib')

// Configs
const BROKERS = process.env.BROKERS || ['localhost:9092']
const CLIENT_ID = 'pets'

// ---------------------------------------------------------------
// DB Sink
const db = new FlatDB(path.resolve(__dirname, './pets.db'))
console.log('DB _meta: ' +  JSON.stringify(db.dbGetMeta(), null, 2))

// ---------------------------------------------------------------
// Kafka
const kafka = new Kafka({
  logLevel: logLevel.INFO,
  brokers: BROKERS,
  clientId: CLIENT_ID,
  retry: {
    initialRetryTime: 1000,
    retries: 16
  }
})

const consumers = []
const producer = kafka.producer()
producer.connect()


// Consume kafka
async function subscribeToPetsAdded () {
  const consumerGroup = 'pets-added-sink'
  try {
    const consumer = kafka.consumer({ groupId: consumerGroup})
    await consumer.connect()
    consumers.push(consumer)
    await consumer.subscribe({ topic: 'pets.added', fromBeginning: true })
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        const prefix = `${topic}[${partition} | ${message.offset}] / ${message.timestamp}`
        console.log(`- ${prefix} ${message.key}#${message.value}`)
        const pet = JSON.parse(message.value)

        // Initial status of PENDING
        pet.status = 'pending' // This status doesn't trigger an event. It should live for a very short time.

        // Save to DB
        db.dbPut(pet.id, pet)
        db.dbPutMeta(`${consumerGroup}.offset`, message.offset + 1)
        consumer.commitOffsets([{topic, partition, offset: message.offset + 1}])

        // Produce: pets.statusChanged
        // It's now available
        producer.send({
          topic: 'pets.statusChanged',
          messages: [
            { value: JSON.stringify({ ...pet, status: 'available'}) },
          ],
        })
      },
    })
    const dbOffset = db.dbGetMeta(`${consumerGroup}.offset`)
    if(dbOffset) {
      console.log(`${consumerGroup} - Seeking to ${dbOffset}`)
      await consumer.seek({ topic: 'pets.added', partition: 0, offset: dbOffset })
    } else {
      console.log(`${consumerGroup} - Not Seeking, leaving default offset from Kafka`)
    }
  } catch(e) {
    console.error(`[${consumerGroup}] ${e.message}`, e)   
  }
}

async function subscribeToPetsStatusChanged () {
  const consumerGroup = 'pets-statusChanged-sink'
  try {
    const consumer = kafka.consumer({ groupId: consumerGroup})
    await consumer.connect()
    consumers.push(consumer)
    await consumer.subscribe({ topic: 'pets.statusChanged', fromBeginning: true })
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        const prefix = `${topic}[${partition} | ${message.offset}] / ${message.timestamp}`
        console.log(`- ${prefix} ${message.key}#${message.value}`)
        const {id, status} = JSON.parse(message.value)

        // Save to DB with new status
        const pet = db.dbGet(id)
        db.dbPut(id, {...pet, status})
        db.dbPutMeta(`${consumerGroup}.offset`, message.offset + 1)
        consumer.commitOffsets([{topic, partition, offset: message.offset + 1}])
      },
    })
    const dbOffset = db.dbGetMeta(`${consumerGroup}.offset`)
    if(dbOffset) {
      console.log(`${consumerGroup} - Seeking to ${dbOffset}`)
      await consumer.seek({ topic: 'pets.added', partition: 0, offset: dbOffset })
    } else {
      console.log(`${consumerGroup} - Not Seeking, leaving default offset from Kafka`)
    }
  } catch(e) {
    console.error(`[${consumerGroup}] ${e.message}`, e)   
  }
}

subscribeToPetsAdded()
subscribeToPetsStatusChanged()


// ---------------------------------------------------------------
// Rest
app.use(morgan('combined'))
app.use(cors())
app.use(bodyParser.json())

app.get('/api/pets', (req, res) => {
  const { location, status } = req.query
  if(!location && !status) {
    return res.json(db.dbGetAll())
  }

  return res.json(db.dbQuery({ location, status }, { caseInsensitive: true }))
})

app.post('/api/pets', (req, res) => {
  const pet = req.body
  pet.id = pet.id || uuid.v4()

  producer.send({
    topic: 'pets.added',
    messages: [
      { value: JSON.stringify(pet) },
    ],
  })

  res.status(201).send(pet)
})

app.patch('/api/pets/:id', (req, res) => {
  const pet = db.dbGet(req.params.id)
  const { status } = req.body
  if(!pet)
    res.status(400).json({
      message: 'Pet not found, cannot patch.'
    })

  const updatedPet = {...pet, status }

  producer.send({
    topic: 'pets.statusChanged',
    messages: [
      { value: JSON.stringify(updatedPet) },
    ],
  })

  res.status(201).send(updatedPet)
})

// // SPA
// app.use(express.static(path.resolve(__dirname, process.env.SPA_PATH || '../web-ui/build')))


// ---------------------------------------------------------------------------------------
// Boring stuff follows...
// ---------------------------------------------------------------------------------------

// Start server and handle logic around graceful exit
const server = app.listen(process.env.NODE_PORT || 3100, () => {
  console.log('Server listening on http://' + server.address().address + ':' + server.address().port)
})
// Keep track of connections to kill 'em off later.
let connections = []
server.on('connection', connection => {
  connections.push(connection);
  connection.on('close', () => connections = connections.filter(curr => curr !== connection));
});

// Exit gracefully
const errorTypes = ['unhandledRejection', 'uncaughtException']
const signalTraps = ['SIGTERM', 'SIGINT', 'SIGUSR2']
errorTypes.forEach(type => {
  process.on(type, async e => {
    try {
      console.log(`process.on ${type}`)
      console.error(e)
      await shutdown()
    } catch (_) {
      process.exit(1)
    }
  })
})


signalTraps.forEach(type => {
  process.once(type, async () => {
    try {
      await shutdown()
    } finally {
      process.kill(process.pid, type)
    }
  })
})


async function shutdown() {
  await Promise.all(consumers.map(consumer => consumer.disconnect()))

  server.close(() => {
    console.log('Closed out remaining connections');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 5000);

  connections.forEach(curr => curr.end());
  setTimeout(() => connections.forEach(curr => curr.destroy()), 5000);
}

