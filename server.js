const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { rankCVs } = require('./utils/rank');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');

const upload = multer({ dest: 'uploads/' });

// In-memory store
let uploadedCVs = [];

app.get('/', (req, res) => {
  res.render('index');
});

app.post('/upload', upload.array('cvs'), (req, res) => {
  const files = req.files;
  files.forEach(file => {
    const content = fs.readFileSync(file.path, 'utf-8');
    uploadedCVs.push({ filename: file.originalname, content });
  });
  res.redirect('/match');
});

app.get('/match', (req, res) => {
  res.render('match', { cvs: uploadedCVs });
});

app.post('/rank', async (req, res) => {
  const jobDescription = req.body.job_description;
  const results = await rankCVs(uploadedCVs, jobDescription);

  res.render('results', { ranked: results });
});

app.post('/send', async (req, res) => {
  const accepted = req.body.accepted;
  const rejected = req.body.rejected;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL,
      pass: process.env.EMAIL_PASS
    }
  });

  for (const cv of accepted) {
    await transporter.sendMail({
      from: process.env.EMAIL,
      to: cv.email,
      subject: "You're Selected!",
      text: `Congratulations ${cv.placeholderName}, you're selected for the role.\n\nReason:\n${cv.reason}`
    });
  }

  for (const cv of rejected) {
    await transporter.sendMail({
      from: process.env.EMAIL,
      to: cv.email,
      subject: "Application Update",
      text: `Dear Candidate, unfortunately you were not selected. Reason:\n${cv.reason}`
    });
  }

  res.send('Emails sent.');
});

setInterval(() => {
  console.log("⏰ Fairness Reminder: Evaluate all applicants objectively!");
}, 5 * 60 * 1000);

app.listen(PORT, () => console.log(`FairHire running on http://localhost:${PORT}`));
