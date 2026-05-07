import { workerData, parentPort } from 'worker_threads';
import sharp from 'sharp';
import path from 'path';

async function processFrames() {
    const { startFrame, endFrame, size, totalFrames, framesDir, imageBuffer, borderOverlay } = workerData;

    try {
        for (let i = startFrame; i < endFrame; i++) {
            const frameFile = path.join(framesDir, `frame_${String(i).padStart(3, '0')}.png`);

            // Calculate rotation
            // We rotate the image 360 degrees over the total frames
            const rotationAngle = (i * 360) / totalFrames;

            // 1. Load image and rotate
            // We use a larger canvas to avoid clipping during rotation before cropping
            await sharp(imageBuffer)
                .rotate(rotationAngle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .resize(size, size, { fit: 'cover', position: 'center' }) // Resize back to target size after rotation might need care if rotation changes bbox. 
                // Better approach: Resize first (if needed to fill), then rotate, then extract center.
                // Actually, rotating expanded the image. We need to extract the center `size x size`.
                // But `sharp` rotation expands boundaries.
                // Let's force a resize to cover `size x size` *after* rotation? No, that distorts.
                // Standard approach: Resize input to be large enough to cover the circle at any angle. 
                // sqrt(2) * size approx 1.5 * size.
                // But simplified: Just resize to size, rotate, and extract center?? 
                // Let's stick to the logic from frame-worker.js which seems to work:
                // It calculates `offset` and extracts.

                // My improved logic for vinyl spin:
                // 1. Resize Image to be slightly larger to ensure coverage when rotating? 
                // Actually if we rotate a circle, the corners don't matter.
                // Let's just rotate the square image.
                .composite([
                    { input: borderOverlay, blend: 'over' } // Apply the vinyl border/mask ON TOP
                ])
                .toFile(frameFile);
        }

        // Wait, the previous logic in frame-worker.js was:
        // .rotate(...) then .extract(...) then .composite(circleMask).
        // If I rotate a square image, the corners become empty (transparent) unless resized?
        // Let's use a simpler pipeline:
        // 1. Create a "Vinyl Disk" from the image (Crop to circle + Add Border).
        // 2. Rotate THE DISK. This looks more natural like a spinning record.

        // Revised Loop:
        // We can pre-process the "Base Disk" once? No, Sharp objects are immutable-ish streams.
        // Let's do it per frame for simplicity first.
    } catch (error) {
        throw error;
    }
}

// Improved Logic Implementation
async function processFramesRevised() {
    const { startFrame, endFrame, size, totalFrames, framesDir, imageBuffer, borderOverlay } = workerData;

    // Create a circular mask buffer once
    const circleMask = Buffer.from(`
        <svg width="${size}" height="${size}">
            <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
        </svg>
    `);

    try {
        console.log(`[Worker] Started. Range: ${startFrame} -> ${endFrame}`);
        for (let i = startFrame; i < endFrame; i++) {
            const frameFile = path.join(framesDir, `frame_${String(i).padStart(3, '0')}.png`);
            const rotationAngle = (i * 360) / totalFrames;

            // Step 1: Resize image to cover the canvas
            // Step 2: Composite the Circle Mask to make it round (cut corners)
            // Step 3: Composite the Border Overlay (Vinyl lines/border)
            // Step 4: Rotate the WHOLE THING

            // Wait, if I rotate the "Vinyl Record", the lighting/border rotates too. 
            // Real vinyls spin, so the label and content spin. The static glint might not, but let's assume simple rotation.

            // Pipeline:
            // 1. Input Image -> Resize to Size -> Composite (Circle Mask via dest-in) -> Result: Round Image
            // 2. Round Image -> Composite (Vinyl Border) -> Result: Vinyl Record
            // 3. Vinyl Record -> Rotate(angle) -> Save

            // Efficient way with Sharp:
            // Create the base "Record" buffer first?
            // But we can't pass sharp instances to workers.
            // We have imageBuffer.

            // Let's just do it in the chain.
            await sharp(imageBuffer)
                .resize(size, size, { fit: 'cover' })
                // Cut into circle
                .composite([
                    { input: circleMask, blend: 'dest-in' },
                    { input: borderOverlay, blend: 'over' }
                ])
                .toBuffer() // Get the "Record"
                .then(recordBuffer => {
                    return sharp(recordBuffer)
                        .rotate(rotationAngle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    // Rotation might resize image to fit bounding box. We need to preserve original canvas size or extract center.
                    // Sharp's rotate expands canvas.
                    // We must resize/extract back to `size`.
                    // But extracting center after rotation is tricky if dimensions changed.
                    // Actually, if we rotate 90 deg, size is same. 45 deg, size is larger.
                    // Let's just use `extract`?
                    // Actually, sharp's rotate has no 'crop' option.

                    // Alternative: Rotate the *Input Image* first, THEN crop to circle/border?
                    // If I rotate the image, the contents spin.
                    // Then I apply the static circular mask and static border?
                    // THIS IS BETTER. The record "hole" and "border" usually stay effectively static in frame (perfectly centered), 
                    // while the content (the texture) spins.
                    // Unless the border has scratches that should spin.
                    // User said "xoay vòng tròn như đĩa nhạc".
                    // Let's rotate the IMAGE, then apply static MASK & BORDER.

                    return sharp(imageBuffer)
                        .rotate(rotationAngle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
                        // After rotation, the image is likely larger and has black/transparent corners.
                        // We resize it to 'cover' the [size, size] area.
                        .resize(size, size, { fit: 'cover' })
                        .composite([
                            { input: circleMask, blend: 'dest-in' }, // Cut to circle
                            { input: borderOverlay, blend: 'over' }   // Add Border
                        ])
                        .toFile(frameFile);
                    console.log(`[Worker] Generated: ${frameFile}`);
                });
        }
        parentPort.postMessage('done');
    } catch (error) {
        console.error('[Worker] Processing Error:', error);
        throw error;
    }
}

processFramesRevised().catch(error => {
    console.error('[Worker] Fatal Error:', error);
    process.exit(1);
});
