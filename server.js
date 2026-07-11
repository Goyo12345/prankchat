const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// L'URL publique de ton serveur Railway (sert à construire les liens vidéo)
const SERVER_URL = 'https://prankchat-production.up.railway.app'

// Taille max acceptée pour une vidéo envoyée (60 Mo). Au-delà, on refuse.
const MAX_UPLOAD = 60 * 1024 * 1024

// Les vidéos sont gardées en mémoire quelques minutes,
// juste le temps qu'OBS et l'ami les lisent.
const videoCache = {}

// Pour chaque personne connectée : dans quelle room elle est + son jeton secret.
// (En mémoire : ça se recrée tout seul quand les gens se reconnectent.)
const socketInfo = {}

// Petit anti-spam : on retient les horaires des dernières actions par clé.
const actionTimes = {}
function allow(key, maxCount, windowMs) {
  const now = Date.now()
  actionTimes[key] = (actionTimes[key] || []).filter((t) => now - t < windowMs)
  if (actionTimes[key].length >= maxCount) return false
  actionTimes[key].push(now)
  return true
}

const server = http.createServer((req, res) => {
  // 1) L'app de l'expéditeur nous envoie une vidéo déjà téléchargée sur son PC
  if (req.method === 'POST' && req.url.startsWith('/upload')) {
    const urlObj = new URL(req.url, 'http://localhost')
    const room = urlObj.searchParams.get('room')
    const caption = urlObj.searchParams.get('caption') || ''
    const senderId = urlObj.searchParams.get('senderId') || ''
    const token = urlObj.searchParams.get('token') || ''

    // Vérif 1 : l'expéditeur doit être une personne réellement connectée à cette
    // room, avec le bon jeton secret. Sinon on refuse (ferme la route aux inconnus).
    const info = socketInfo[senderId]
    if (!room || !info || info.room !== room || info.token !== token) {
      res.writeHead(403)
      res.end('non autorise')
      return
    }

    // Vérif 2 : pas plus de 10 vidéos par minute par expéditeur (anti-spam).
    if (!allow(`upload_${senderId}`, 10, 60000)) {
      res.writeHead(429)
      res.end('trop de vidéos, ralentis')
      return
    }

    // On récupère les octets de la vidéo, en refusant si c'est trop gros.
    const chunks = []
    let total = 0
    let tooBig = false
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_UPLOAD) {
        tooBig = true
        res.writeHead(413)
        res.end('vidéo trop lourde')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooBig) return
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

  socket.on('join-room', (roomCode, callback) => {
    // Anti-devinette : max 60 tentatives de connexion par minute et par adresse,
    // pour empêcher quelqu'un d'essayer des milliers de codes à la chaîne.
    const ip = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '')
      .split(',')[0]
      .trim()
    if (!allow(`join_${ip}`, 60, 60000)) {
      console.log('Trop de tentatives de connexion depuis', ip)
      if (typeof callback === 'function') callback(null)
      return
    }

    // On génère un jeton secret unique pour cette personne dans cette room.
    const token = crypto.randomBytes(16).toString('hex')
    socketInfo[socket.id] = { room: roomCode, token: token }

    socket.join(roomCode)
    rooms[roomCode] = rooms[roomCode] || []
    rooms[roomCode].push(socket.id)
    console.log(`${socket.id} a rejoint la room: ${roomCode}`)

    socket.to(roomCode).emit('friend-connected')
    io.to(roomCode).emit('room-users', rooms[roomCode].length)

    // On renvoie le jeton à l'app (elle le présentera pour envoyer une vidéo).
    if (typeof callback === 'function') callback(token)
  })

  // Images, GIFs et vidéos .mp4 directes : on relaie l'URL telle quelle.
  // Les liens YouTube/TikTok NE passent PAS par ici : ils sont téléchargés
  // sur le PC de l'expéditeur puis envoyés via /upload (voir plus haut).
  socket.on('send-prank', (data) => {
    const info = socketInfo[socket.id]
    // On n'accepte que si la personne est bien dans la room qu'elle vise...
    if (!info || info.room !== data.roomCode) return
    // ...et pas plus de 15 vannes par minute (anti-spam).
    if (!allow(`prank_${socket.id}`, 15, 60000)) return

    socket.to(data.roomCode).emit('receive-prank', {
      imageUrl: data.imageUrl,
      caption: data.caption
    })
  })

  socket.on('disconnect', () => {
    console.log('Utilisateur déconnecté:', socket.id)
    delete socketInfo[socket.id]
    delete actionTimes[`upload_${socket.id}`]
    delete actionTimes[`prank_${socket.id}`]
    for (const room in rooms) {
      rooms[room] = rooms[room].filter((id) => id !== socket.id)
    }
  })
})

server.listen(process.env.PORT || 3000, () => {
  console.log('Serveur PrankChat lancé sur le port', process.env.PORT || 3000)
})
