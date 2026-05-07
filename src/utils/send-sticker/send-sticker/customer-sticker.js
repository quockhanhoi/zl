import fs from "fs";
import path from "path";
import { tempDir } from "../../io-json.js";
import { getVideoMetadata } from "../../../api-zalo/api-zalo/utils.js";
import { convertToWebp } from "./create-webp.js";
import { deleteFile } from "../../util.js";
import { loadConfig } from "../../../utils/config.js";
const getGlobalPrefix = () => loadConfig().bot?.prefix || "-";
import { removeMention } from "../../format-util.js";

// Dummy functions for missing dependencies
const getCachedMedia = () => null;
const setCacheData = () => null;
const sendMessageCompleteRequest = async (api, message, data, ttl) => {
    return await api.sendMessage({ msg: data.caption, quote: message, ttl }, message.threadId, message.type);
};
const sendMessageFailed = async (api, message, msg) => {
    return await api.sendMessage({ msg, quote: message }, message.threadId, message.type);
};

const dataStickerPath = path.join(process.cwd(), "assets", "resources", "sticker");
const PLATFORM = "ZaloCustomSticker";

export async function handleSendCustomerStickerVideo(api, message, aliasCommand) {
	const prefix = getGlobalPrefix();
	const content = removeMention(message);
	const keyword = content.replace(prefix + aliasCommand, "").trim();

	if (!keyword) {
		const files = fs.readdirSync(dataStickerPath);
		const fileList = files.map((file, index) => `${index + 1}. ${path.parse(file).name}`).join("\n");
		await sendMessageCompleteRequest(api, message, {
			caption: `Đây là những sticker đã lưu trữ:\n${fileList}`
				+ `\n\nDùng lệnh: ${prefix}${aliasCommand} <tên sticker> để gửi sticker`
		}, 1800000);
		return;
	}

	await sendCustomerStickerVideo(api, message, keyword);
}


async function sendCustomerStickerVideo(api, message, keyword) {
	const files = fs.readdirSync(dataStickerPath);
	const stickerFile = files.find(file => path.parse(file).name === keyword);

	if (!stickerFile) {
		await sendMessageFailed(api, message, "Trong danh sách lưu trữ Không có tên sticker này", false);
		return;
	}

	const fileExt = path.parse(stickerFile).ext;
	const stickerPath = path.join(dataStickerPath, stickerFile);
	let pathWebp = null;
	const nameLocalSticker = keyword;

	try {
		let cachedVideo = await getCachedMedia(PLATFORM, stickerFile, fileExt, nameLocalSticker);
		let webpUrl;
		let width;
		let height;
		if (cachedVideo) {
			webpUrl = cachedVideo.fileUrl;
			width = cachedVideo.width;
			height = cachedVideo.height;
		} else {
			pathWebp = path.join(tempDir, `sticker_${Date.now()}.webp`);
			let uploadFile = pathWebp;
			if (fileExt === ".webp") {
				uploadFile = stickerPath;
			} else {
				await convertToWebp(stickerPath, pathWebp);
			}
			const linkUploadZalo = await api.uploadAttachment([uploadFile], message.threadId, message.type);
			webpUrl = linkUploadZalo[0].fileUrl || linkUploadZalo[0].normalUrl;

			const stickerData = await getVideoMetadata(stickerPath);
			width = stickerData.width;
			height = stickerData.height;
			setCacheData(PLATFORM, stickerFile, {
				fileUrl: webpUrl,
				title: nameLocalSticker,
				width: width,
				height: height,
				duration: stickerData.duration
			}, fileExt);
		}

		await api.sendCustomSticker(
			message,
			webpUrl,
			webpUrl,
			width,
			height
		);

	} catch (error) {
		console.error("Lỗi khi gửi sticker:", error);
	} finally {
		if (pathWebp) await deleteFile(pathWebp);
	}
}
