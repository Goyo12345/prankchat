const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const os = require('os')
const https = require('https')

const ytdlpPath = path.join(os.tmpdir(), 'yt-dlp')

// Stockage vidéos en mémoire
const videoCache = {}

function setupYtdlp() {
  if (!fs.existsSync(ytdlpPath)) {
    console.log('Installation de yt-dlp...')
    const file = fs.createWriteStream(ytdlpPath)
    
    function download(url) {
      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          download(response.headers.location)
        } else {
          response.pipe(file)
          file.on('finish', () => {
            file.close()
            fs.chmodSync(ytdlpPath, '755')
            console.log('yt-dlp installé !')
          })
        }
      }).on('error', (e) => {
        console.error('Erreur installation yt-dlp:', e)
      })
    }
    download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp')
  } else {
    console.log('yt-dlp déjà présent')
  }
}

function isYoutubeOrTiktok(url) {
  return url.includes('youtube.com') || 
         url.includes('youtu.be') || 
         url.includes('tiktok.com')
}

function downloadVideo(url) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `prankchat_${Date.now()}.mp4`)
    const cmd = `${ytdlpPath} -o "${tmpFile}" --no-playlist -f "worst[ext=mp4]/worst" --max-filesize 10m "${url}"`
    
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Erreur yt-dlp:', stderr)
        reject(error)
        return
      }
      
      console.log('Téléchargement terminé:', tmpFile)
      
      // Lire la vidéo en mémoire
      const videoBuffer = fs.readFileSync(tmpFile)
      fs.unlinkSync(tmpFile)
      
      const videoId = `video_${Date.now()}`
      videoCache[videoId] = videoBuffer
      
      // Supprimer de la mémoire après 60 secondes
      setTimeout(() => {
        delete videoCache[videoId]
        console.log('Vidéo supprimée de la mémoire:', videoId)
      }, 60000)
      
      resolve(videoId)
    })
  })
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/video/')) {
    const videoId = req.url.replace('/video/', '')
    console.log('Cherche vidéo en mémoire:', videoId)
    
    if (videoCache[videoId]) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' })
      res.end(videoCache[videoId])
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  } else if (req.url === '/obs' || req.url.startsWith('/obs?')) {
    const filePath = path.join(__dirname, 'obs.html')
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(data)
    })
  } else {
    res.writeHead(200)
    res.end('PrankChat server running')
  }
})

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
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

  socket.on('send-prank', async (data) => {
    if (isYoutubeOrTiktok(data.imageUrl)) {
      try {
        console.log('Téléchargement:', data.imageUrl)
        const videoId = await downloadVideo(data.imageUrl)
        const videoUrl = `https://prankchat-production.up.railway.app/video/${videoId}`
        console.log('URL vidéo:', videoUrl)
        
        socket.to(data.roomCode).emit('receive-prank', {
          imageUrl: videoUrl,
          caption: data.caption
        })
      } catch (e) {
        console.error('Erreur téléchargement:', e)
      }
    } else {
      socket.to(data.roomCode).emit('receive-prank', {
        imageUrl: data.imageUrl,
        caption: data.caption
      })
    }
  })

  socket.on('disconnect', () => {
    console.log('Utilisateur déconnecté:', socket.id)
    for (const room in rooms) {
      rooms[room] = rooms[room].filter(id => id !== socket.id)
    }
  })
})

setupYtdlp()

server.listen(process.env.PORT || 3000, () => {
  console.log('Serveur PrankChat lancé sur le port', process.env.PORT || 3000)
})