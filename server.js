const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')

// L'URL publique de ton serveur Railway (sert à construire les liens vidéo)
const SERVER_URL = 'https://prankchat-production.up.railway.app'

// Taille max acceptée pour une vidéo envoyée (60 Mo). Au-delà, on refuse.
const MAX_UPLOAD = 60 * 1024 * 1024

// Les vidéos sont écrites sur le DISQUE (plus dans la RAM) le temps qu'OBS et
// l'ami les lisent, puis supprimées. Ça évite de saturer la mémoire du serveur.
const VIDEO_DIR = path.join(os.tmpdir(), 'prankchat_videos')

// Au démarrage : on crée le dossier et on efface d'éventuelles vidéos restantes.
try {
  fs.mkdirSync(VIDEO_DIR, { recursive: true })
  for (const f of fs.readdirSync(VIDEO_DIR)) {
    fs.unlinkSync(path.join(VIDEO_DIR, f))
  }
} catch (e) {
  console.error('Erreur préparation dossier vidéos:', e)
}

// Un identifiant de vidéo valide ressemble à "video_1699999999999.mp4".
// On le vérifie pour empêcher qu'on lise un autre fichier du serveur (sécurité).
function safeVideoId(id) {
  return /^video_\d+\.mp4$/.test(id) ? id : null
}

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
    const duration = urlObj.searchParams.get('duration') || ''
    const position = urlObj.searchParams.get('position') || 'center'
    const size = urlObj.searchParams.get('size') || 'medium'

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

    // On écrit la vidéo directement sur le disque, au fil de l'eau (sans jamais
    // charger le fichier entier en mémoire), en refusant si ça dépasse le max.
    const videoId = `video_${Date.now()}.mp4`
    const filePath = path.join(VIDEO_DIR, videoId)
    const writeStream = fs.createWriteStream(filePath)
    let total = 0
    let aborted = false

    function abort(code, message) {
      if (aborted) return
      aborted = true
      req.destroy()
      writeStream.destroy()
      fs.unlink(filePath, () => {})
      res.writeHead(code)
      res.end(message)
    }

    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_UPLOAD) abort(413, 'vidéo trop lourde')
    })
    req.on('error', () => abort(400, 'erreur reception'))
    writeStream.on('error', () => abort(500, 'erreur ecriture'))
    req.pipe(writeStream)

    writeStream.on('finish', () => {
      if (aborted) return
      console.log(`Vidéo reçue (${(total / 1024 / 1024).toFixed(1)} Mo) -> ${videoId}`)

      // On supprime le fichier du disque après 2 minutes.
      setTimeout(() => {
        fs.unlink(filePath, () => {})
        console.log('Vidéo supprimée du disque:', videoId)
      }, 120000)

      // On envoie le lien direct .mp4 à toute la room (OBS + ami),
      // sauf à l'expéditeur qui l'affiche déjà lui-même.
      const videoUrl = `${SERVER_URL}/video/${videoId}`
      io.to(room).except(senderId).emit('receive-prank', {
        imageUrl: videoUrl,
        caption: caption,
        duration: duration ? parseInt(duration, 10) : undefined,
        position: position,
        size: size
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ videoUrl }))
    })
    return
  }

  // 2) OBS (ou l'ami) lit une vidéo depuis le disque
  if (req.url.startsWith('/video/')) {
    const videoId = safeVideoId(req.url.replace('/video/', ''))
    if (!videoId) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const filePath = path.join(VIDEO_DIR, videoId)
    fs.stat(filePath, (err, stats) => {
      if (err) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stats.size,
        'Access-Control-Allow-Origin': '*'
      })
      // On envoie le fichier au fil de l'eau (pas chargé entièrement en RAM).
      fs.createReadStream(filePath).pipe(res)
    })
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
      caption: data.caption,
      duration: data.duration,
      position: data.position,
      size: data.size
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
