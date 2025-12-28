const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');

const execPromise = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'video-generator' });
});

app.post('/create-video', upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'images', maxCount: 100 }
]), async (req, res) => {
  let tempFiles = [];
  
  try {
    console.log('📥 Recibiendo petición para crear video...');
    
    const { subtitles, duration = 60 } = req.body;
    const audioFile = req.files['audio']?.[0];
    const imageFiles = req.files['images'] || [];
    
    if (!audioFile || imageFiles.length === 0) {
      return res.status(400).json({ 
        error: 'Se requiere audio e imágenes' 
      });
    }
    
    tempFiles.push(audioFile.path);
    imageFiles.forEach(f => tempFiles.push(f.path));
    
    console.log(`✅ Audio: ${audioFile.filename}`);
    console.log(`✅ Imágenes: ${imageFiles.length}`);
    
    const fileListPath = path.join(__dirname, 'uploads', `filelist-${Date.now()}.txt`);
    const imageDuration = duration / imageFiles.length;
    const fileListContent = imageFiles
      .map(f => `file '${path.basename(f.path)}'\nduration ${imageDuration}`)
      .join('\n');
    
    await fs.writeFile(fileListPath, fileListContent);
    tempFiles.push(fileListPath);
    
    let subtitlePath = null;
    if (subtitles && subtitles.length > 0) {
      subtitlePath = path.join(__dirname, 'uploads', `subtitles-${Date.now()}.srt`);
      const srtContent = createSRTContent(subtitles);
      await fs.writeFile(subtitlePath, srtContent);
      tempFiles.push(subtitlePath);
    }
    
    const outputPath = path.join(__dirname, 'uploads', `video-${Date.now()}.mp4`);
    tempFiles.push(outputPath);
    
    console.log('🎬 Generando video con FFmpeg...');
    
    let ffmpegCommand = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -i "${audioFile.path}" `;
    
    if (subtitlePath) {
      ffmpegCommand += `-vf "subtitles=${subtitlePath}:force_style='FontName=Arial,FontSize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Alignment=2'" `;
    }
    
    ffmpegCommand += `-c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "${outputPath}"`;
    
    const { stdout, stderr } = await execPromise(ffmpegCommand, { 
      cwd: path.join(__dirname, 'uploads'),
      maxBuffer: 10 * 1024 * 1024 
    });
    
    console.log('✅ Video generado exitosamente');
    
    const stats = await fs.stat(outputPath);
    console.log(`📦 Tamaño del video: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    res.json({
      success: true,
      message: 'Video creado exitosamente',
      videoPath: `/download/${path.basename(outputPath)}`,
      size: stats.size,
      duration: duration
    });
    
    setTimeout(async () => {
      for (const file of tempFiles) {
        try {
          await fs.unlink(file);
        } catch (err) {
          console.error(`Error limpiando ${file}:`, err.message);
        }
      }
    }, 5 * 60 * 1000);
    
  } catch (error) {
    console.error('❌ Error creando video:', error);
    
    for (const file of tempFiles) {
      try {
        await fs.unlink(file);
      } catch (err) {}
    }
    
    res.status(500).json({ 
      error: 'Error generando video', 
      details: error.message 
    });
  }
});

app.get('/download/:filename', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'uploads', req.params.filename);
    await fs.access(filePath);
    res.download(filePath);
  } catch (error) {
    res.status(404).json({ error: 'Archivo no encontrado' });
  }
});

function createSRTContent(subtitles) {
  return subtitles.map((sub, index) => {
    const start = formatSRTTime(sub.start);
    const end = formatSRTTime(sub.end);
    return `${index + 1}\n${start} --> ${end}\n${sub.text}\n`;
  }).join('\n');
}

function formatSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}

function pad(num, size = 2) {
  return String(num).padStart(size, '0');
}

app.listen(PORT, () => {
  console.log(`🚀 Video Generator Service running on port ${PORT}`);
});
