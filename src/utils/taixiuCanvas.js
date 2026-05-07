import { createCanvas, registerFont, loadImage } from "canvas";
import fs from "node:fs";
import path from "node:path";

const txAssetDir = path.join(process.cwd(), "src/modules/cache");
const cacheDir = path.join(process.cwd(), "src/modules/cache");

// Helper for rounding
function drawRoundRect(ctx, x, y, width, height, radius) {
  if (radius === undefined) radius = 0;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Vẽ hiệu ứng chữ nổi với viền và bóng đổ
 */
function drawTextWithEffects(ctx, text, x, y, fontSize, fontWeight, gradientColors, outlineColor, outlineWidth, shadowColor, shadowBlur) {
  ctx.save();
  ctx.font = `${fontWeight} ${fontSize}px BeVietnamProBold, Sans`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (shadowColor) {
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
  }

  const textWidth = ctx.measureText(text).width;
  const gradient = ctx.createLinearGradient(x - textWidth / 2, y, x + textWidth / 2, y);
  gradientColors.forEach((color, index) => {
    const stop = index / (gradientColors.length - 1);
    gradient.addColorStop(stop, color);
  });

  if (outlineColor) {
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = outlineWidth;
    ctx.strokeText(text, x, y);
  }

  ctx.fillStyle = gradient;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Vẽ kết quả Tài Xỉu Luxury
 */
export async function createTaiXiuResultImage(result, taiTotal, xiuTotal, jackpotInfo) {
  const width = 800;
  let height = 300;
  if (jackpotInfo?.isJackpot) height = 360;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // 1. Background Gradient
  const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width / 2);
  if (jackpotInfo?.isJackpot) {
    gradient.addColorStop(0, "#B8860B"); // Gold
    gradient.addColorStop(0.7, "#8B6914");
    gradient.addColorStop(1, "#3c2a0a");
  } else {
    gradient.addColorStop(0, "#2a0000"); // Red Dark
    gradient.addColorStop(0.7, "#0f0000");
    gradient.addColorStop(1, "#000000");
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Sparkling effect
  for (let i = 0; i < 50; i++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    ctx.beginPath();
    ctx.arc(x, y, Math.random() * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.5})`;
    ctx.fill();
  }

  // 2. Center Plate
  const centerX = width / 2;
  const centerY = height / 2;
  const plateRadius = 90;
  ctx.beginPath();
  ctx.arc(centerX, centerY, plateRadius, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 215, 0, 0.3)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // 3. Draw Dices
  const diceSize = 45;
  const dicePositions = [];
  const isOverlapping = (x, y, positions) => {
    return positions.some(pos => Math.sqrt((pos.x - x) ** 2 + (pos.y - y) ** 2) < diceSize * 1.1);
  };

  for (let i = 0; i < result.dice.length; i++) {
    const val = result.dice[i];
    let x, y, attempts = 0;
    do {
      const angle = Math.random() * 2 * Math.PI;
      const distance = Math.random() * (plateRadius - diceSize / 2 - 5);
      x = centerX + distance * Math.cos(angle);
      y = centerY + distance * Math.sin(angle);
      attempts++;
    } while (isOverlapping(x, y, dicePositions) && attempts < 100);
    dicePositions.push({ x, y });

    try {
      const diceImg = await loadImage(path.join(txAssetDir, `dice_${val}.png`));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.random() * 2 * Math.PI);
      ctx.drawImage(diceImg, -diceSize / 2, -diceSize / 2, diceSize, diceSize);
      ctx.restore();
    } catch (e) {
      // Fallback to text icon if image fails
      ctx.fillStyle = "white";
      ctx.font = "30px Sans";
      ctx.textAlign = "center";
      ctx.fillText(["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][val], x, y + 10);
    }
  }

  // 4. Result Text (TAI/XIU)
  const isTai = result.result === "tai";
  const resultText = isTai ? "TÀI" : "XỈU";
  const resultColors = isTai ? ["#FF0000", "#FFD700", "#FF0000"] : ["#00FFFF", "#FFFFFF", "#00FFFF"];
  drawTextWithEffects(ctx, resultText, centerX, centerY - plateRadius - 15, 40, "bold", resultColors, "#000000", 3, "rgba(0,0,0,0.5)", 8);

  // 5. Total Points
  drawTextWithEffects(ctx, String(result.total), centerX, centerY + plateRadius + 25, 30, "bold", ["#ffffff", "#cccccc"], "#000000", 2, "rgba(0,0,0,0.5)", 5);

  // 6. Bet Totals
  const winGrad = ["#FFFF00", "#FFD700", "#FFA500"];
  const loseGrad = ["#A9A9A9", "#808080", "#696969"];

  // Tai Side
  drawTextWithEffects(ctx, "Tài", 150, centerY - 15, 32, "bold", isTai ? winGrad : loseGrad, "#000000", 2, null, 0);
  drawTextWithEffects(ctx, taiTotal.toLocaleString(), 150, centerY + 20, 24, "normal", isTai ? winGrad : loseGrad, "#000000", 1, null, 0);

  // Xiu Side
  drawTextWithEffects(ctx, "Xỉu", width - 150, centerY - 15, 32, "bold", !isTai ? winGrad : loseGrad, "#000000", 2, null, 0);
  drawTextWithEffects(ctx, xiuTotal.toLocaleString(), width - 150, centerY + 20, 24, "normal", !isTai ? winGrad : loseGrad, "#000000", 1, null, 0);

  // 7. Jackpot
  if (jackpotInfo?.isJackpot) {
    const jpText = `🎰 NỔ HŨ: ${jackpotInfo.amount.toLocaleString()} XU 💰`;
    drawTextWithEffects(ctx, jpText, centerX, height - 30, 28, "bold", ["#FFD700", "#FFF8DC", "#FFD700"], "#000000", 3, "rgba(255,215,0,0.3)", 10);
  }

  return canvas.toBuffer("image/png");
}

/**
 * Vẽ ảnh đếm ngược chờ kết quả
 */
export async function createWaitingImage(seconds, taiTotal, xiuTotal) {
  const width = 800, height = 300;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#120000");
  bg.addColorStop(1, "#000000");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const centerX = width / 2, centerY = height / 2;

  // Outer circle for timer
  ctx.beginPath();
  ctx.arc(centerX, centerY, 80, 0, 2 * Math.PI);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 10;
  ctx.stroke();

  // Progress arc
  ctx.beginPath();
  ctx.arc(centerX, centerY, 80, -Math.PI / 2, (-Math.PI / 2) + (seconds / 60) * 2 * Math.PI);
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.stroke();

  // Timer text
  drawTextWithEffects(ctx, String(seconds), centerX, centerY, 60, "bold", ["#ffffff", "#cccccc"], "#000000", 3, "#fbbf24", 10);

  // Side Labels
  drawTextWithEffects(ctx, "TÀI", 150, centerY - 20, 35, "bold", ["#FF9999", "#FF0000"], "#000000", 2, null, 0);
  drawTextWithEffects(ctx, taiTotal.toLocaleString(), 150, centerY + 25, 28, "normal", ["#ffffff", "#dddddd"], "#000000", 1, null, 0);

  drawTextWithEffects(ctx, "XỈU", width - 150, centerY - 20, 35, "bold", ["#99FFFF", "#00FFFF"], "#000000", 2, null, 0);
  drawTextWithEffects(ctx, xiuTotal.toLocaleString(), width - 150, centerY + 25, 28, "normal", ["#ffffff", "#dddddd"], "#000000", 1, null, 0);

  ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
  ctx.font = "italic 16px Sans";
  ctx.textAlign = "center";
  ctx.fillText("!tx [tai/xiu] [s? ti?n] d? d?t cu?c", centerX, height - 20);

  return canvas.toBuffer("image/png");
}
