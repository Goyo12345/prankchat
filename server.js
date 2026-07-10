const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs')
const path = require('path')

// L'URL publique de ton serveur Railway (sert à construire les liens vidéo)
const SERVER_URL = 'https://prankchat-production.up.railway.app'

// Les vidéos sont gardées en mémoire quelques minutes,
// juste le temps qu'OBS et l'ami les lisent.
const videoCache = {}

const server = http.createServer((req, res) => {
  // 1) L'app de l'expéditeur nous envoie une vidéo déjà téléchargée sur son PC
  if (req.method === 'POST' && req.url.startsWith('/upload')) {
    const urlObj = new URL(req.url, 'http://localhost')
    const room = urlObj.searchParams.get('room')
    const caption = urlObj.searchParams.get('caption') || ''
    const senderId = urlObj.searchParams.get('senderId') || ''

    if (!room) {
      res.writeHead(400)
      res.end('room manquant')
      return
    }

    // On récupère les octets de la vidéo au fur et à mesure
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const buffer = Buffer.concat(chunks)
      const videoId = `video_${Date.now()}.mp4`
      videoCache[videoId] = buffer
      console.log(`Vidéo reçue (${(buffer.length / 1024 / 1024).toFixed(1)} Mo) -> ${videoId}`)

      // On la supprime de la mémoire après 2 minutes
      setTimeout(() => {
        delete videoCache[videoId]
        console.log('Vidéo supprimée de la mémoire:', videoId)
      }, 120000)

      // On envoie le lien direct .mp4 à toute la room (OBS + ami),
      // sauf à l'expéditeur qui l'affiche déjà lui-même.
      const videoUrl = `${SERVER_URL}/video/${videoId}`
      io.to(room).except(senderId).emit('receive-prank', {
        imageUrl: videoUrl,
        caption: caption
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ videoUrl }))
    })
    return
  }

  // 2) OBS (ou l'ami) lit une vidéo gardée en mémoire
  if (req.url.startsWith('/video/')) {
    const videoId = req.url.replace('/video/', '')
    console.log('Cherche vidéo en mémoire:', videoId)

    if (videoCache[videoId]) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(videoCache[videoId])
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
    return
  }

  // 3) La page OBS
  if (req.url === '/obs' || req.url.startsWith('/obs?')) {
    fs.readFile(path.join(__dirname, 'obs.html'), (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(data)
    })
    return
  }

  res.writeHead(200)
  res.end('PrankChat server running')
})

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

const rooms = {}

io.on('connection', (socket) => {
  console.log('Utilisateur connecté:', socket.id)

  socket.on('join-room', (roomCode) => {
    socket.join(roomCode)
    rooms[roomCode] = rooms[roomCode] || []
    rooms[roomCode].push(socket.id)
    console.log(`${socket.id} a rejoint la room: ${roomCode}`)

    socket.to(roomCode).emit('friend-connected')
    io.to(roomCode).emit('room-users', rooms[roomCode].length)
  })

  // Images, GIFs et vidéos .mp4 directes : on relaie l'URL telle quelle.
  // Les liens YouTube/TikTok NE passent PAS par ici : ils sont téléchargés
  // sur le PC de l'expéditeur puis envoyés via /upload (voir plus haut).
  socket.on('send-prank', (data) => {
    socket.to(data.roomCode).emit('receive-prank', {
      imageUrl: data.imageUrl,
      caption: data.caption
    })
  })

  socket.on('disconnect', () => {
    console.log('Utilisateur déconnecté:', socket.id)
    for (const room in rooms) {
      rooms[room] = rooms[room].filter((id) => id !== socket.id)
    }
  })
})

server.listen(process.env.PORT || 3000, () => {
  console.log('Serveur PrankChat lancé sur le port', process.env.PORT || 3000)
})
