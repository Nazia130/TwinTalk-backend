const video = document.getElementById("video");
const canvas = document.getElementById("snapshotCanvas");
const ctx = canvas.getContext("2d");

// Start webcam
navigator.mediaDevices.getUserMedia({ video: true })
  .then(stream => {
    video.srcObject = stream;
  })
  .catch(err => {
    alert("Camera access denied: " + err);
  });

// Save preset avatar
function selectPreset(src) {
  localStorage.setItem("userAvatar", src);
  alert("Preset avatar selected! Now join a meeting to use it.");
}

// Capture and cartoonize snapshot
function captureSnapshot() {
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Cartoon effect: reduce color depth
  let imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i]   = Math.floor(data[i] / 64) * 64;     // R
    data[i+1] = Math.floor(data[i+1] / 64) * 64;   // G
    data[i+2] = Math.floor(data[i+2] / 64) * 64;   // B
  }
  ctx.putImageData(imgData, 0, 0);

  const dataUrl = canvas.toDataURL("image/png");
  localStorage.setItem("userAvatar", dataUrl);

  alert("Custom avatar saved! Now join a meeting to use it.");
}
