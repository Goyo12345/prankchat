const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs')
const path = require('path')
const { exec, execSync } = require('child_process')
const os = require('os')

// Installer yt-dlp au démarrage si pas présent
const ytdlpPath = path.join(os.tmpdir(), 'yt-dlp')

function setupYtdlp() {
  if (!fs.existsSync(ytdlpPath)) {
    console.log('Installation de yt-dlp...')
    try {
      execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${ytdlpPath} && chmod +x ${ytdlpPath}`)
      console.log('yt-dlp installé !')
    } catch (e) {
      console.error('Erreur installation yt-dlp:', e)
    }
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
    const cmd = `${ytdlpPath} -o "${tmpFile}" --no-playlist -f "best[ext=mp4]/best" --max-filesize 50m "${url}"`
    
    exec(cmd, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve(tmpFile)
    })
  })
}

const server = http.createServer((req, res) => {
  if (req.url === '/obs' || req.url.startsWith('/obs?')) {
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
  },
  maxHttpBufferSize: 1e8
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
        const tmpFile = await downloadVideo(data.imageUrl)
        const videoBuffer = fs.readFileSync(tmpFile)
        const base64 = videoBuffer.toString('base64')
        
        // Supprimer le fichier tmp
        fs.unlinkSync(tmpFile)
        
        // Envoyer la vidéo en base64 à la room
        socket.to(data.roomCode).emit('receive-prank', {
          caption: data.caption,
          videoBase64: base64
        })
      } catch (e) {
        console.error('Erreur téléchargement:', e)
        socket.to(data.roomCode).emit('receive-prank', {
          imageUrl: data.imageUrl,
          caption: data.caption
        })
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