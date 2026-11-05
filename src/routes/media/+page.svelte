<script lang="ts">
	import { onMount } from 'svelte';

	type MediaKind = 'photo' | 'video' | 'audio';

	interface DeviceInfo {
		online: boolean;
		last_heartbeat: number;
		tunnel_url: string;
		gpu_status: string;
		hostname: string;
	}

	interface JobResult {
		id: string;
		inputName: string;
		outputName: string;
		mediaType: MediaKind;
		origSize: number;
		outSize: number;
		dimensions?: string;
		downloadUrl: string;
		transcript?: string;
		srt?: string;
		vtt?: string;
		guitarTab?: string;
		elapsedSec?: number;
		engine: string;
	}

	let device = $state<DeviceInfo>({
		online: false,
		last_heartbeat: 0,
		tunnel_url: '',
		gpu_status: '',
		hostname: 'ryan-nixos'
	});
	let localDaemonOnline = $state(false);

	// Active media state
	let activeTab = $state<MediaKind>('photo');
	let filesQueue = $state<File[]>([]);
	let selectedIdx = $state(0);
	let previewUrl = $state('');
	let mediaWidth = $state(0);
	let mediaHeight = $state(0);
	let mediaDuration = $state(0);
	let currentPlayTime = $state(0);
	let dragActive = $state(false);
	let processing = $state(false);
	let statusMsg = $state('');
	let enginePref = $state<'auto' | 'browser' | 'server'>('auto');
	let results = $state<JobResult[]>([]);
	let activeTranscript = $state('');
	let activeSrt = $state('');
	let activeVtt = $state('');
	let activeGuitarTab = $state('');

	// Mic / Camera capture inside converter
	let isRecordingAudio = $state(false);
	let recSeconds = $state(0);
	let mediaRecorder: MediaRecorder | null = null;
	let recChunks: BlobPart[] = [];
	let recTimer: any = null;

	// PHOTO options
	let photoFormat = $state('jpg');
	let photoQuality = $state(88);
	let photoScalePct = $state(100);
	let photoMaxDim = $state(0);
	let photoCustomW = $state(0);
	let photoCustomH = $state(0);
	let photoLockAspect = $state(true);
	let photoRotateDeg = $state(0);
	let photoFineAngle = $state(0);
	let photoFlipH = $state(false);
	let photoFlipV = $state(false);
	let photoCropAspect = $state('free');
	let photoBrightness = $state(1.0);
	let photoContrast = $state(1.0);
	let photoSaturation = $state(1.0);
	let photoSharpness = $state(1.0);
	let photoBlurPx = $state(0);
	let photoGrayscale = $state(false);
	let photoInvert = $state(false);
	let photoSepia = $state(false);
	let photoAutocontrast = $state(false);
	let photoDocScan = $state(false);
	let photoStripExif = $state(true);
	let photoTranscribe = $state(false);
	let photoTranscribeHint = $state('');

	// VIDEO options
	let videoFormat = $state('mp4');
	let videoCodec = $state('h264');
	let videoResolution = $state('original');
	let videoCustomW = $state(0);
	let videoCustomH = $state(0);
	let videoFps = $state(0);
	let videoCrf = $state(23);
	let videoTargetMb = $state(0);
	let videoRotateDeg = $state(0);
	let videoFlipH = $state(false);
	let videoFlipV = $state(false);
	let videoGrayscale = $state(false);
	let videoTrimStart = $state('');
	let videoTrimEnd = $state('');
	let videoSpeed = $state(1.0);
	let videoMute = $state(false);
	let videoNormalize = $state(false);
	let videoGainDb = $state(0);
	let videoTranscribe = $state(false);
	let videoBurnSubs = $state(false);

	// AUDIO options
	let audioFormat = $state('mp3');
	let audioBitrate = $state('192k');
	let audioSampleRate = $state(0);
	let audioChannels = $state(0);
	let audioTrimStart = $state('');
	let audioTrimEnd = $state('');
	let audioSpeed = $state(1.0);
	let audioPitchSemitones = $state(0);
	let audioGainDb = $state(0);
	let audioFadeIn = $state(0);
	let audioFadeOut = $state(0);
	let audioNormalize = $state(false);
	let audioStripSilence = $state(false);
	let audioVoiceClean = $state(false);
	let audioReverse = $state(false);
	let audioTranscribe = $state(false);
	let audioGuitarTab = $state(false);

	let fileInputEl: HTMLInputElement | undefined = $state();
	let videoPreviewEl: HTMLVideoElement | undefined = $state();
	let audioPreviewEl: HTMLAudioElement | undefined = $state();
	let waveformCanvasEl: HTMLCanvasElement | undefined = $state();

	let currentFile = $derived(filesQueue[selectedIdx] || null);

	let cssFilterPreview = $derived.by(() => {
		if (activeTab !== 'photo') return '';
		const parts: string[] = [];
		if (photoBrightness !== 1) parts.push(`brightness(${photoBrightness})`);
		if (photoContrast !== 1) parts.push(`contrast(${photoContrast})`);
		if (photoSaturation !== 1) parts.push(`saturate(${photoSaturation})`);
		if (photoGrayscale || photoDocScan) parts.push('grayscale(1)');
		if (photoInvert) parts.push('invert(1)');
		if (photoSepia) parts.push('sepia(1)');
		if (photoBlurPx > 0) parts.push(`blur(${photoBlurPx}px)`);
		if (photoDocScan) parts.push('contrast(1.65) brightness(1.08)');
		return parts.join(' ');
	});

	let cssTransformPreview = $derived.by(() => {
		const rot = (activeTab === 'photo' ? photoRotateDeg + photoFineAngle : videoRotateDeg) || 0;
		const sx = (activeTab === 'photo' ? photoFlipH : videoFlipH) ? -1 : 1;
		const sy = (activeTab === 'photo' ? photoFlipV : videoFlipV) ? -1 : 1;
		return `rotate(${rot}deg) scale(${sx}, ${sy})`;
	});

	async function pollBackendStatus() {
		// 1. Check local daemon on 127.0.0.1:8766
		try {
			const c = new AbortController();
			const id = setTimeout(() => c.abort(), 1200);
			const r = await fetch('http://127.0.0.1:8766/api/state', { signal: c.signal });
			clearTimeout(id);
			localDaemonOnline = r.ok;
		} catch {
			localDaemonOnline = false;
		}

		// 2. Check Cosmo D1 device state
		try {
			const res = await fetch('/cosmo/api?action=state', { cache: 'no-store' });
			if (res.ok) {
				const data = await res.json();
				if (data.ok && data.device) {
					device = data.device;
				}
			}
		} catch {}
	}

	onMount(() => {
		pollBackendStatus();
		const timer = setInterval(pollBackendStatus, 5000);

		const onPaste = (e: ClipboardEvent) => {
			if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
				loadFiles(e.clipboardData.files);
			}
		};
		window.addEventListener('paste', onPaste);
		return () => {
			clearInterval(timer);
			window.removeEventListener('paste', onPaste);
		};
	});

	function detectMediaKind(file: File): MediaKind {
		const t = (file.type || '').toLowerCase();
		const ext = file.name.split('.').pop()?.toLowerCase() || '';
		if (t.startsWith('video/') || ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'].includes(ext)) {
			return 'video';
		}
		if (t.startsWith('audio/') || ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'aac'].includes(ext)) {
			return 'audio';
		}
		return 'photo';
	}

	function loadFiles(list: FileList | File[] | null) {
		if (!list || list.length === 0) return;
		const arr = Array.from(list);
		filesQueue = arr;
		selectedIdx = 0;
		selectFile(0);
	}

	function selectFile(idx: number) {
		selectedIdx = idx;
		const f = filesQueue[idx];
		if (!f) return;
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = URL.createObjectURL(f);
		const kind = detectMediaKind(f);
		activeTab = kind;
		mediaWidth = 0;
		mediaHeight = 0;
		mediaDuration = 0;

		if (kind === 'photo') {
			const img = new Image();
			img.onload = () => {
				mediaWidth = img.naturalWidth;
				mediaHeight = img.naturalHeight;
				photoCustomW = img.naturalWidth;
				photoCustomH = img.naturalHeight;
			};
			img.src = previewUrl;
		} else if (kind === 'audio') {
			drawAudioWaveform(f);
		}
	}

	async function drawAudioWaveform(file: File) {
		try {
			const arrayBuf = await file.arrayBuffer();
			const actx = new (window.AudioContext || (window as any).webkitAudioContext)();
			const audioBuf = await actx.decodeAudioData(arrayBuf);
			mediaDuration = audioBuf.duration;
			const raw = audioBuf.getChannelData(0);
			setTimeout(() => {
				if (!waveformCanvasEl) return;
				const ctx = waveformCanvasEl.getContext('2d');
				if (!ctx) return;
				const w = (waveformCanvasEl.width = waveformCanvasEl.clientWidth || 500);
				const h = (waveformCanvasEl.height = 72);
				ctx.fillStyle = '#09090b';
				ctx.fillRect(0, 0, w, h);
				ctx.strokeStyle = '#9ffdd8';
				ctx.lineWidth = 1.2;
				ctx.beginPath();
				const step = Math.max(1, Math.floor(raw.length / w));
				const mid = h / 2;
				for (let x = 0; x < w; x++) {
					let min = 1.0;
					let max = -1.0;
					const start = x * step;
					for (let j = 0; j < step && start + j < raw.length; j++) {
						const v = raw[start + j];
						if (v < min) min = v;
						if (v > max) max = v;
					}
					ctx.moveTo(x, mid + min * mid * 0.9);
					ctx.lineTo(x, mid + max * mid * 0.9);
				}
				ctx.stroke();
			}, 40);
			actx.close();
		} catch {}
	}

	function onCustomWChange(val: number) {
		photoCustomW = val;
		if (photoLockAspect && mediaWidth > 0 && mediaHeight > 0 && val > 0) {
			photoCustomH = Math.round((val * mediaHeight) / mediaWidth);
		}
	}

	function onCustomHChange(val: number) {
		photoCustomH = val;
		if (photoLockAspect && mediaWidth > 0 && mediaHeight > 0 && val > 0) {
			photoCustomW = Math.round((val * mediaWidth) / mediaHeight);
		}
	}

	function resetPhotoAdjustments() {
		photoScalePct = 100;
		photoMaxDim = 0;
		photoCustomW = mediaWidth;
		photoCustomH = mediaHeight;
		photoRotateDeg = 0;
		photoFineAngle = 0;
		photoFlipH = false;
		photoFlipV = false;
		photoCropAspect = 'free';
		photoBrightness = 1.0;
		photoContrast = 1.0;
		photoSaturation = 1.0;
		photoSharpness = 1.0;
		photoBlurPx = 0;
		photoGrayscale = false;
		photoInvert = false;
		photoSepia = false;
		photoAutocontrast = false;
		photoDocScan = false;
	}

	function formatBytes(bytes: number): string {
		if (!bytes || bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}

	function formatTime(sec: number): string {
		if (!sec || !isFinite(sec)) return '0:00';
		const m = Math.floor(sec / 60);
		const s = (sec % 60).toFixed(1).padStart(4, '0');
		return `${m}:${s}`;
	}

	function setTrimFromPlayhead(which: 'start' | 'end') {
		const t = currentPlayTime.toFixed(2);
		if (activeTab === 'video') {
			if (which === 'start') videoTrimStart = t;
			else videoTrimEnd = t;
		} else if (activeTab === 'audio') {
			if (which === 'start') audioTrimStart = t;
			else audioTrimEnd = t;
		}
	}

	async function grabVideoFrame() {
		if (!videoPreviewEl) return;
		const v = videoPreviewEl;
		const canvas = document.createElement('canvas');
		canvas.width = v.videoWidth || 1280;
		canvas.height = v.videoHeight || 720;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
		const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/png'));
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const outName = `${(currentFile?.name || 'video').replace(/\.[^.]+$/, '')}_frame_${currentPlayTime.toFixed(1)}s.png`;
		results = [
			{
				id: `frame_${Date.now()}`,
				inputName: currentFile?.name || 'video',
				outputName: outName,
				mediaType: 'photo',
				origSize: currentFile?.size || 0,
				outSize: blob.size,
				dimensions: `${canvas.width}x${canvas.height}`,
				downloadUrl: url,
				engine: 'browser-frame-grab'
			},
			...results
		];
		statusMsg = `grabbed frame (${canvas.width}x${canvas.height})`;
	}

	async function toggleAudioRecord() {
		if (isRecordingAudio) {
			if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
			if (recTimer) clearInterval(recTimer);
			isRecordingAudio = false;
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			recChunks = [];
			recSeconds = 0;
			mediaRecorder = new MediaRecorder(stream);
			mediaRecorder.ondataavailable = (e) => {
				if (e.data && e.data.size > 0) recChunks.push(e.data);
			};
			mediaRecorder.onstop = () => {
				stream.getTracks().forEach((t) => t.stop());
				const blob = new Blob(recChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
				const ext = (mediaRecorder?.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
				const file = new File([blob], `mic_recording_${Date.now()}.${ext}`, {
					type: blob.type || 'audio/webm'
				});
				loadFiles([file]);
				statusMsg = `recorded ${recSeconds}s audio`;
			};
			mediaRecorder.start(250);
			isRecordingAudio = true;
			recTimer = setInterval(() => {
				recSeconds += 1;
			}, 1000);
		} catch (err: any) {
			statusMsg = `mic error: ${err?.message || err}`;
		}
	}

	// Browser-side Photo Conversion (instant fallback & zero-latency)
	async function convertPhotoInBrowser(file: File): Promise<JobResult> {
		const t0 = performance.now();
		const bitmap = await createImageBitmap(file);
		let srcW = bitmap.width;
		let srcH = bitmap.height;

		// Aspect ratio crop calculation
		let cropX = 0;
		let cropY = 0;
		let cropW = srcW;
		let cropH = srcH;
		const aspectMap: Record<string, number> = {
			'1:1': 1,
			'16:9': 16 / 9,
			'9:16': 9 / 16,
			'4:3': 4 / 3,
			'3:2': 3 / 2,
			a4: 1 / 1.4142
		};
		if (photoCropAspect in aspectMap) {
			const targetRatio = aspectMap[photoCropAspect];
			const curRatio = srcW / srcH;
			if (curRatio > targetRatio) {
				cropW = Math.round(srcH * targetRatio);
				cropX = Math.floor((srcW - cropW) / 2);
			} else {
				cropH = Math.round(srcW / targetRatio);
				cropY = Math.floor((srcH - cropH) / 2);
			}
		}

		// Target dimensions
		let outW = cropW;
		let outH = cropH;
		if (photoCustomW > 0 && photoCustomH > 0 && (photoCustomW !== mediaWidth || photoCustomH !== mediaHeight)) {
			outW = photoCustomW;
			outH = photoCustomH;
		} else if (photoMaxDim > 0 && Math.max(outW, outH) > photoMaxDim) {
			const s = photoMaxDim / Math.max(outW, outH);
			outW = Math.max(1, Math.round(outW * s));
			outH = Math.max(1, Math.round(outH * s));
		} else if (photoScalePct !== 100 && photoScalePct > 0) {
			const s = photoScalePct / 100;
			outW = Math.max(1, Math.round(outW * s));
			outH = Math.max(1, Math.round(outH * s));
		}

		const totalRot = ((photoRotateDeg + photoFineAngle) % 360 + 360) % 360;
		const swapDims = totalRot === 90 || totalRot === 270;
		const canvasW = swapDims ? outH : outW;
		const canvasH = swapDims ? outW : outH;

		const canvas = document.createElement('canvas');
		canvas.width = canvasW;
		canvas.height = canvasH;
		const ctx = canvas.getContext('2d')!;

		if (photoFormat === 'jpg' || photoFormat === 'bmp' || photoFormat === 'pdf') {
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, canvasW, canvasH);
		}

		ctx.filter = cssFilterPreview || 'none';
		ctx.save();
		ctx.translate(canvasW / 2, canvasH / 2);
		if (totalRot !== 0) ctx.rotate((totalRot * Math.PI) / 180);
		ctx.scale(photoFlipH ? -1 : 1, photoFlipV ? -1 : 1);
		ctx.drawImage(bitmap, cropX, cropY, cropW, cropH, -outW / 2, -outH / 2, outW, outH);
		ctx.restore();

		const mimeMap: Record<string, string> = {
			jpg: 'image/jpeg',
			png: 'image/png',
			webp: 'image/webp',
			avif: 'image/avif',
			ico: 'image/png',
			bmp: 'image/bmp'
		};
		const mime = mimeMap[photoFormat] || 'image/jpeg';
		const blob: Blob = await new Promise((resolve) =>
			canvas.toBlob((b) => resolve(b || new Blob()), mime, photoQuality / 100)
		);
		const url = URL.createObjectURL(blob);
		const stem = file.name.replace(/\.[^.]+$/, '');
		const outName = `${stem}_${canvasW}x${canvasH}.${photoFormat}`;

		return {
			id: `photo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			inputName: file.name,
			outputName: outName,
			mediaType: 'photo',
			origSize: file.size,
			outSize: blob.size,
			dimensions: `${canvasW}x${canvasH}`,
			downloadUrl: url,
			elapsedSec: Number(((performance.now() - t0) / 1000).toFixed(2)),
			engine: 'browser-canvas'
		};
	}

	// Browser-side Audio WAV Conversion + Trim + Speed/Pitch + Normalize + Reverse
	async function convertAudioInBrowser(file: File): Promise<JobResult> {
		const t0 = performance.now();
		const arrayBuf = await file.arrayBuffer();
		const actx = new (window.AudioContext || (window as any).webkitAudioContext)();
		const decoded = await actx.decodeAudioData(arrayBuf);
		await actx.close();

		const sr = audioSampleRate > 0 ? audioSampleRate : decoded.sampleRate;
		const numCh = audioChannels === 1 ? 1 : decoded.numberOfChannels;
		const startSec = Math.max(0, parseFloat(audioTrimStart || '0') || 0);
		const endSec = parseFloat(audioTrimEnd || '0') > startSec ? parseFloat(audioTrimEnd) : decoded.duration;
		const clipDur = Math.max(0.1, endSec - startSec);
		const pitchFactor = Math.pow(2, audioPitchSemitones / 12);
		const playbackRate = Math.max(0.25, Math.min(4.0, audioSpeed * pitchFactor));
		const renderedDur = clipDur / playbackRate;

		const offline = new OfflineAudioContext(numCh, Math.ceil(renderedDur * sr), sr);
		const src = offline.createBufferSource();

		if (audioReverse) {
			for (let c = 0; c < decoded.numberOfChannels; c++) {
				Array.prototype.reverse.call(decoded.getChannelData(c));
			}
		}

		src.buffer = decoded;
		src.playbackRate.value = playbackRate;

		let lastNode: AudioNode = src;
		if (audioVoiceClean) {
			const hp = offline.createBiquadFilter();
			hp.type = 'highpass';
			hp.frequency.value = 85;
			const lp = offline.createBiquadFilter();
			lp.type = 'lowpass';
			lp.frequency.value = 8000;
			lastNode.connect(hp);
			hp.connect(lp);
			lastNode = lp;
		}

		const gainNode = offline.createGain();
		const linearGain = Math.pow(10, audioGainDb / 20);
		gainNode.gain.setValueAtTime(linearGain, 0);
		if (audioFadeIn > 0) {
			gainNode.gain.setValueAtTime(0.001, 0);
			gainNode.gain.linearRampToValueAtTime(linearGain, Math.min(audioFadeIn, renderedDur));
		}
		if (audioFadeOut > 0 && renderedDur > audioFadeOut) {
			gainNode.gain.setValueAtTime(linearGain, renderedDur - audioFadeOut);
			gainNode.gain.linearRampToValueAtTime(0.001, renderedDur);
		}
		lastNode.connect(gainNode);
		gainNode.connect(offline.destination);

		src.start(0, startSec, clipDur);
		const rendered = await offline.startRendering();

		// Peak normalize if requested
		if (audioNormalize) {
			let peak = 0;
			for (let c = 0; c < rendered.numberOfChannels; c++) {
				const ch = rendered.getChannelData(c);
				for (let i = 0; i < ch.length; i++) {
					const a = Math.abs(ch[i]);
					if (a > peak) peak = a;
				}
			}
			if (peak > 0.001) {
				const normScale = 0.96 / peak;
				for (let c = 0; c < rendered.numberOfChannels; c++) {
					const ch = rendered.getChannelData(c);
					for (let i = 0; i < ch.length; i++) ch[i] *= normScale;
				}
			}
		}

		const wavBlob = audioBufferToWavBlob(rendered);
		const url = URL.createObjectURL(wavBlob);
		const stem = file.name.replace(/\.[^.]+$/, '');
		const outName = `${stem}_conv.wav`;

		return {
			id: `audio_${Date.now()}`,
			inputName: file.name,
			outputName: outName,
			mediaType: 'audio',
			origSize: file.size,
			outSize: wavBlob.size,
			downloadUrl: url,
			elapsedSec: Number(((performance.now() - t0) / 1000).toFixed(2)),
			engine: 'browser-webaudio'
		};
	}

	function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
		const numCh = buffer.numberOfChannels;
		const sampleRate = buffer.sampleRate;
		const length = buffer.length * numCh * 2 + 44;
		const out = new ArrayBuffer(length);
		const view = new DataView(out);
		const writeStr = (offset: number, s: string) => {
			for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
		};
		writeStr(0, 'RIFF');
		view.setUint32(4, length - 8, true);
		writeStr(8, 'WAVE');
		writeStr(12, 'fmt ');
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, numCh, true);
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * numCh * 2, true);
		view.setUint16(32, numCh * 2, true);
		view.setUint16(34, 16, true);
		writeStr(36, 'data');
		view.setUint32(40, length - 44, true);

		const channels: Float32Array[] = [];
		for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
		let offset = 44;
		for (let i = 0; i < buffer.length; i++) {
			for (let c = 0; c < numCh; c++) {
				const s = Math.max(-1, Math.min(1, channels[c][i]));
				view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
				offset += 2;
			}
		}
		return new Blob([out], { type: 'audio/wav' });
	}

	function buildOptionsPayload(): Record<string, any> {
		if (activeTab === 'photo') {
			return {
				media_type: 'photo',
				format: photoFormat,
				quality: photoQuality,
				scale_pct: photoScalePct,
				max_dim: photoMaxDim,
				width: photoCustomW !== mediaWidth ? photoCustomW : 0,
				height: photoCustomH !== mediaHeight ? photoCustomH : 0,
				rotate_deg: photoRotateDeg + photoFineAngle,
				flip_h: photoFlipH,
				flip_v: photoFlipV,
				crop_aspect: photoCropAspect,
				brightness: photoBrightness,
				contrast: photoContrast,
				saturation: photoSaturation,
				sharpness: photoSharpness,
				grayscale: photoGrayscale,
				invert: photoInvert,
				autocontrast: photoAutocontrast,
				doc_scan: photoDocScan,
				strip_exif: photoStripExif,
				transcribe: photoTranscribe,
				transcribe_hint: photoTranscribeHint
			};
		}
		if (activeTab === 'video') {
			return {
				media_type: 'video',
				format: videoFormat,
				video_codec: videoCodec,
				resolution: videoResolution,
				width: videoCustomW,
				height: videoCustomH,
				fps: videoFps,
				crf: videoCrf,
				target_mb: videoTargetMb,
				rotate_deg: videoRotateDeg,
				flip_h: videoFlipH,
				flip_v: videoFlipV,
				grayscale: videoGrayscale,
				trim_start: videoTrimStart,
				trim_end: videoTrimEnd,
				speed: videoSpeed,
				mute_audio: videoMute,
				normalize_audio: videoNormalize,
				gain_db: videoGainDb,
				transcribe: videoTranscribe,
				burn_subtitles: videoBurnSubs
			};
		}
		return {
			media_type: 'audio',
			format: audioFormat,
			bitrate: audioBitrate,
			sample_rate: audioSampleRate,
			channels: audioChannels,
			trim_start: audioTrimStart,
			trim_end: audioTrimEnd,
			speed: audioSpeed,
			pitch_semitones: audioPitchSemitones,
			gain_db: audioGainDb,
			fade_in: audioFadeIn,
			fade_out: audioFadeOut,
			normalize_audio: audioNormalize,
			strip_silence: audioStripSilence,
			voice_clean: audioVoiceClean,
			transcribe: audioTranscribe,
			guitar_tab: audioGuitarTab
		};
	}

	async function convertViaServerOrBridge(file: File, options: Record<string, any>): Promise<JobResult> {
		// 1. Try direct HTTP to local daemon (127.0.0.1:8766) or Cloudflare tunnel
		const endpoints: string[] = [];
		if (localDaemonOnline) endpoints.push('http://127.0.0.1:8766');
		if (device.tunnel_url && device.online) endpoints.push(device.tunnel_url.replace(/\/$/, ''));

		for (const base of endpoints) {
			try {
				const res = await fetch(`${base}/api/media/convert`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/octet-stream',
						'X-Filename': encodeURIComponent(file.name),
						'X-Options': encodeURIComponent(JSON.stringify(options))
					},
					body: file
				});
				const data = await res.json();
				if (data.ok) {
					if (data.transcript) activeTranscript = data.transcript;
					if (data.srt) activeSrt = data.srt;
					if (data.vtt) activeVtt = data.vtt;
					if (data.guitar_tab) activeGuitarTab = data.guitar_tab;
					return {
						id: `srv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						inputName: file.name,
						outputName: data.output_filename,
						mediaType: data.media_type,
						origSize: data.orig_size_bytes || file.size,
						outSize: data.output_size_bytes || 0,
						dimensions: data.output_dimensions,
						downloadUrl: `${base}${data.download_url}`,
						transcript: data.transcript,
						srt: data.srt,
						vtt: data.vtt,
						guitarTab: data.guitar_tab,
						elapsedSec: data.elapsed_sec,
						engine: 'ryan-nixos (ffmpeg/gpu)'
					};
				}
			} catch {}
		}

		// 2. Fallback: Queue via /cosmo/api D1 bridge and wait for ryan-nixos poller
		if (device.online) {
			statusMsg = 'queuing via cosmo bridge...';
			const buf = await file.arrayBuffer();
			const bytes = new Uint8Array(buf);
			let bin = '';
			const chunk = 0x8000;
			for (let i = 0; i < bytes.length; i += chunk) {
				bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
			}
			const b64 = btoa(bin);
			const upRes = await fetch('/cosmo/api', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'upload',
					filename: file.name,
					mime_type: file.type || 'application/octet-stream',
					category: 'media_convert',
					course_hint: 'none',
					auto_route: 0,
					note_text: JSON.stringify(options),
					data_b64: b64,
					size_bytes: file.size
				})
			});
			const upData = await upRes.json();
			if (!upData.ok) throw new Error(upData.error || 'queue failed');
			const dropId = upData.id;

			for (let attempt = 0; attempt < 45; attempt++) {
				await new Promise((r) => setTimeout(r, 2000));
				const stRes = await fetch('/cosmo/api?action=state', { cache: 'no-store' });
				const stData = await stRes.json();
				const found = (stData.drops || []).find((d: any) => d.id === dropId);
				if (found && found.status === 'converted') {
					let meta: any = {};
					try {
						meta = JSON.parse(found.summary || '{}');
					} catch {}
					const outId = meta.out_drop_id || found.routed_to;
					if (meta.transcript) activeTranscript = meta.transcript;
					if (meta.srt) activeSrt = meta.srt;
					if (meta.vtt) activeVtt = meta.vtt;
					if (meta.guitar_tab) activeGuitarTab = meta.guitar_tab;
					return {
						id: dropId,
						inputName: file.name,
						outputName: meta.output_filename || found.badge || `converted_${file.name}`,
						mediaType: activeTab,
						origSize: file.size,
						outSize: meta.output_size_bytes || 0,
						dimensions: meta.output_dimensions,
						downloadUrl: `/cosmo/api?action=download&id=${encodeURIComponent(outId)}`,
						transcript: meta.transcript,
						srt: meta.srt,
						vtt: meta.vtt,
						guitarTab: meta.guitar_tab,
						elapsedSec: meta.elapsed_sec,
						engine: 'cosmo-bridge (gpu)'
					};
				}
			}
			throw new Error('conversion timed out waiting for daemon');
		}

		throw new Error('ryan-nixos offline for server-only codec/transcription');
	}

	async function runConversion() {
		if (filesQueue.length === 0) {
			statusMsg = 'select or drop a file first';
			return;
		}
		processing = true;
		statusMsg = 'processing...';
		const options = buildOptionsPayload();

		const needsServer =
			enginePref === 'server' ||
			(enginePref === 'auto' &&
				(localDaemonOnline || device.online) &&
				(activeTab === 'video' ||
					photoTranscribe ||
					photoDocScan ||
					photoFormat === 'pdf' ||
					photoFormat === 'tiff' ||
					audioTranscribe ||
					audioGuitarTab ||
					audioFormat !== 'wav'));

		try {
			for (let i = 0; i < filesQueue.length; i++) {
				const f = filesQueue[i];
				statusMsg = `converting ${i + 1}/${filesQueue.length}: ${f.name}`;
				let job: JobResult;
				if (needsServer) {
					try {
						job = await convertViaServerOrBridge(f, options);
					} catch (srvErr) {
						if (activeTab === 'photo') {
							job = await convertPhotoInBrowser(f);
						} else if (activeTab === 'audio') {
							job = await convertAudioInBrowser(f);
						} else {
							throw srvErr;
						}
					}
				} else if (activeTab === 'photo') {
					job = await convertPhotoInBrowser(f);
				} else if (activeTab === 'audio') {
					job = await convertAudioInBrowser(f);
				} else {
					job = await convertViaServerOrBridge(f, options);
				}
				results = [job, ...results];
			}
			statusMsg = `done (${filesQueue.length} file${filesQueue.length > 1 ? 's' : ''})`;
		} catch (err: any) {
			statusMsg = `error: ${err?.message || err}`;
		} finally {
			processing = false;
		}
	}

	function downloadTextBlob(content: string, filename: string) {
		const b = new Blob([content], { type: 'text/plain;charset=utf-8' });
		const u = URL.createObjectURL(b);
		const a = document.createElement('a');
		a.href = u;
		a.download = filename;
		a.click();
		setTimeout(() => URL.revokeObjectURL(u), 2000);
	}
</script>

<svelte:head>
	<title>media</title>
</svelte:head>

<div class="wrap">
	<header class="topbar">
		<div class="left">
			<a href="/" class="brand">peckhamr.com</a>
			<span class="sep">/</span>
			<a href="/cosmo/" class="brand">cosmo</a>
			<span class="sep">/</span>
			<span class="current">media</span>
		</div>
		<div class="right">
			{#if statusMsg}
				<span class="msg">{statusMsg}</span>
			{/if}
			<select class="mini-select" bind:value={enginePref} title="execution engine">
				<option value="auto">engine: auto</option>
				<option value="browser">engine: browser</option>
				<option value="server">engine: nixos gpu</option>
			</select>
			<span class="status" class:online={localDaemonOnline || device.online}>
				<span class="dot"></span>
				{localDaemonOnline ? 'local:8766' : device.online ? 'nixos:online' : 'browser-only'}
			</span>
		</div>
	</header>

	<!-- Mode Switcher & Dropbar -->
	<div class="mode-bar">
		<div class="tabs">
			<button type="button" class:active={activeTab === 'photo'} onclick={() => (activeTab = 'photo')}>
				photo
			</button>
			<button type="button" class:active={activeTab === 'video'} onclick={() => (activeTab = 'video')}>
				video
			</button>
			<button type="button" class:active={activeTab === 'audio'} onclick={() => (activeTab = 'audio')}>
				audio
			</button>
		</div>

		<div class="quick-actions">
			<button type="button" class="btn" class:rec={isRecordingAudio} onclick={toggleAudioRecord}>
				{isRecordingAudio ? `stop mic (${recSeconds}s)` : 'rec mic'}
			</button>
			<button type="button" class="btn" onclick={() => fileInputEl?.click()}>select files</button>
			<button type="button" class="btn accent" disabled={processing || !currentFile} onclick={runConversion}>
				{processing ? 'working...' : `convert${filesQueue.length > 1 ? ` (${filesQueue.length})` : ''}`}
			</button>
		</div>
	</div>

	<input
		type="file"
		multiple
		accept="image/*,video/*,audio/*,.heic,.heif,.mkv,.flac,.opus,.webm"
		style="display:none"
		bind:this={fileInputEl}
		onchange={(e) => loadFiles((e.currentTarget as HTMLInputElement).files)}
	/>

	<div class="main-grid">
		<!-- Left Column: Dropzone + Live Preview + Queue -->
		<section class="panel preview-panel">
			<div class="panel-head">
				<span>input / preview</span>
				{#if currentFile}
					<span class="muted">
						{currentFile.name} · {formatBytes(currentFile.size)}
						{mediaWidth ? ` · ${mediaWidth}×${mediaHeight}` : ''}
						{mediaDuration ? ` · ${formatTime(mediaDuration)}` : ''}
					</span>
				{/if}
			</div>

			<div
				class="dropzone"
				class:drag={dragActive}
				class:compact={!!currentFile}
				role="button"
				tabindex="0"
				ondragover={(e) => {
					e.preventDefault();
					dragActive = true;
				}}
				ondragleave={() => (dragActive = false)}
				ondrop={(e) => {
					e.preventDefault();
					dragActive = false;
					loadFiles(e.dataTransfer?.files || null);
				}}
				onclick={() => fileInputEl?.click()}
				onkeydown={(e) => e.key === 'Enter' && fileInputEl?.click()}
			>
				{currentFile ? 'drop / click / paste (ctrl+v) to replace files' : 'drop photo, video, or audio · click to browse · paste (ctrl+v)'}
			</div>

			{#if currentFile && previewUrl}
				<div class="stage">
					{#if activeTab === 'photo'}
						<img
							src={previewUrl}
							alt="preview"
							class="stage-img"
							style="filter: {cssFilterPreview}; transform: {cssTransformPreview};"
						/>
					{:else if activeTab === 'video'}
						<!-- svelte-ignore a11y_media_has_caption -->
						<video
							bind:this={videoPreviewEl}
							src={previewUrl}
							controls
							class="stage-video"
							style="transform: {cssTransformPreview}; filter: {videoGrayscale ? 'grayscale(1)' : 'none'};"
							onloadedmetadata={(e) => {
								const v = e.currentTarget as HTMLVideoElement;
								mediaWidth = v.videoWidth;
								mediaHeight = v.videoHeight;
								mediaDuration = v.duration;
							}}
							ontimeupdate={(e) => {
								currentPlayTime = (e.currentTarget as HTMLVideoElement).currentTime;
							}}
						></video>
						<div class="stage-bar">
							<span class="muted">t={formatTime(currentPlayTime)}</span>
							<button type="button" class="btn-xs" onclick={() => setTrimFromPlayhead('start')}>[ set start</button>
							<button type="button" class="btn-xs" onclick={() => setTrimFromPlayhead('end')}>set end ]</button>
							<button type="button" class="btn-xs" onclick={grabVideoFrame}>frame -> png</button>
						</div>
					{:else if activeTab === 'audio'}
						<div class="audio-stage">
							<canvas bind:this={waveformCanvasEl} class="waveform"></canvas>
							<audio
								bind:this={audioPreviewEl}
								src={previewUrl}
								controls
								class="stage-audio"
								ontimeupdate={(e) => {
									currentPlayTime = (e.currentTarget as HTMLAudioElement).currentTime;
								}}
							></audio>
							<div class="stage-bar">
								<span class="muted">t={formatTime(currentPlayTime)}</span>
								<button type="button" class="btn-xs" onclick={() => setTrimFromPlayhead('start')}>[ set start</button>
								<button type="button" class="btn-xs" onclick={() => setTrimFromPlayhead('end')}>set end ]</button>
							</div>
						</div>
					{/if}
				</div>
			{/if}

			{#if filesQueue.length > 1}
				<div class="batch-strip">
					{#each filesQueue as f, idx}
						<button
							type="button"
							class="batch-pill"
							class:selected={idx === selectedIdx}
							onclick={() => selectFile(idx)}
						>
							{f.name}
						</button>
					{/each}
				</div>
			{/if}
		</section>

		<!-- Right Column: Dense Feature Matrix for Active Media Type -->
		<section class="panel controls-panel">
			{#if activeTab === 'photo'}
				<div class="panel-head">
					<span>photo parameters</span>
					<button type="button" class="btn-link" onclick={resetPhotoAdjustments}>reset</button>
				</div>

				<div class="ctrl-grid">
					<label class="field">
						<span>format</span>
						<select bind:value={photoFormat}>
							<option value="jpg">jpg</option>
							<option value="png">png</option>
							<option value="webp">webp</option>
							<option value="avif">avif</option>
							<option value="pdf">pdf (document)</option>
							<option value="ico">ico (favicon)</option>
							<option value="bmp">bmp</option>
							<option value="tiff">tiff</option>
							<option value="gif">gif</option>
						</select>
					</label>

					<label class="field">
						<span>quality ({photoQuality}%)</span>
						<input type="range" min="5" max="100" bind:value={photoQuality} />
					</label>

					<label class="field">
						<span>downscale %</span>
						<select bind:value={photoScalePct}>
							<option value={100}>100% (original)</option>
							<option value={75}>75%</option>
							<option value={50}>50%</option>
							<option value={33}>33%</option>
							<option value={25}>25%</option>
							<option value={10}>10%</option>
						</select>
					</label>

					<label class="field">
						<span>max edge px</span>
						<select bind:value={photoMaxDim}>
							<option value={0}>none</option>
							<option value={3840}>3840px (4k)</option>
							<option value={2560}>2560px (2k)</option>
							<option value={1920}>1920px (1080p)</option>
							<option value={1280}>1280px (720p)</option>
							<option value={800}>800px</option>
							<option value={512}>512px</option>
							<option value={256}>256px</option>
						</select>
					</label>

					<label class="field">
						<span>width (px)</span>
						<input
							type="number"
							min="0"
							value={photoCustomW}
							oninput={(e) => onCustomWChange(Number((e.currentTarget as HTMLInputElement).value))}
						/>
					</label>

					<label class="field">
						<span>height (px)</span>
						<input
							type="number"
							min="0"
							value={photoCustomH}
							oninput={(e) => onCustomHChange(Number((e.currentTarget as HTMLInputElement).value))}
						/>
					</label>

					<label class="field">
						<span>aspect crop</span>
						<select bind:value={photoCropAspect}>
							<option value="free">free (no crop)</option>
							<option value="1:1">1:1 square</option>
							<option value="16:9">16:9 widescreen</option>
							<option value="9:16">9:16 vertical</option>
							<option value="4:3">4:3 standard</option>
							<option value="3:2">3:2 photo</option>
							<option value="a4">a4 / letter</option>
						</select>
					</label>

					<div class="field">
						<span>rotate / flip</span>
						<div class="btn-group">
							<button type="button" class="btn-xs" onclick={() => (photoRotateDeg = (photoRotateDeg + 270) % 360)}>-90°</button>
							<button type="button" class="btn-xs" onclick={() => (photoRotateDeg = (photoRotateDeg + 90) % 360)}>+90°</button>
							<button type="button" class="btn-xs" onclick={() => (photoRotateDeg = (photoRotateDeg + 180) % 360)}>180°</button>
							<button type="button" class="btn-xs" class:on={photoFlipH} onclick={() => (photoFlipH = !photoFlipH)}>flip H</button>
							<button type="button" class="btn-xs" class:on={photoFlipV} onclick={() => (photoFlipV = !photoFlipV)}>flip V</button>
						</div>
					</div>

					<label class="field">
						<span>fine angle ({photoFineAngle}°)</span>
						<input type="range" min="-45" max="45" step="0.5" bind:value={photoFineAngle} />
					</label>

					<label class="field">
						<span>brightness ({photoBrightness})</span>
						<input type="range" min="0.2" max="2.0" step="0.05" bind:value={photoBrightness} />
					</label>

					<label class="field">
						<span>contrast ({photoContrast})</span>
						<input type="range" min="0.2" max="2.5" step="0.05" bind:value={photoContrast} />
					</label>

					<label class="field">
						<span>saturation ({photoSaturation})</span>
						<input type="range" min="0.0" max="2.5" step="0.05" bind:value={photoSaturation} />
					</label>

					<label class="field">
						<span>sharpness ({photoSharpness})</span>
						<input type="range" min="0.0" max="3.0" step="0.1" bind:value={photoSharpness} />
					</label>

					<label class="field">
						<span>blur ({photoBlurPx}px)</span>
						<input type="range" min="0" max="20" step="0.5" bind:value={photoBlurPx} />
					</label>
				</div>

				<div class="toggles-row">
					<label class="chk"><input type="checkbox" bind:checked={photoLockAspect} /><span>lock aspect</span></label>
					<label class="chk"><input type="checkbox" bind:checked={photoStripExif} /><span>strip exif</span></label>
					<label class="chk"><input type="checkbox" bind:checked={photoGrayscale} /><span>grayscale</span></label>
					<label class="chk"><input type="checkbox" bind:checked={photoInvert} /><span>invert</span></label>
					<label class="chk"><input type="checkbox" bind:checked={photoSepia} /><span>sepia</span></label>
					<label class="chk"><input type="checkbox" bind:checked={photoAutocontrast} /><span>auto-level</span></label>
					<label class="chk"><input type="checkbox" bind:checked={photoDocScan} /><span>doc scan (clahe)</span></label>
					<label class="chk"><input type="checkbox" bind:checked={photoTranscribe} /><span>ocr / latex (vlm)</span></label>
				</div>

				{#if photoTranscribe}
					<input
						type="text"
						class="input"
						placeholder="optional context/topic hint for vlm ocr..."
						bind:value={photoTranscribeHint}
					/>
				{/if}

			{:else if activeTab === 'video'}
				<div class="panel-head">
					<span>video parameters</span>
					<button
						type="button"
						class="btn-link"
						onclick={() => {
							videoResolution = 'original';
							videoFps = 0;
							videoCrf = 23;
							videoTargetMb = 0;
							videoRotateDeg = 0;
							videoFlipH = false;
							videoFlipV = false;
							videoTrimStart = '';
							videoTrimEnd = '';
							videoSpeed = 1.0;
						}}
					>
						reset
					</button>
				</div>

				<div class="ctrl-grid">
					<label class="field">
						<span>format / output</span>
						<select bind:value={videoFormat}>
							<option value="mp4">mp4 (video)</option>
							<option value="webm">webm (vp9)</option>
							<option value="mkv">mkv</option>
							<option value="mov">mov</option>
							<option value="gif">animated gif</option>
							<option value="mp3">extract audio -> mp3</option>
							<option value="wav">extract audio -> wav</option>
							<option value="m4a">extract audio -> m4a</option>
							<option value="flac">extract audio -> flac</option>
							<option value="opus">extract audio -> opus</option>
						</select>
					</label>

					<label class="field">
						<span>codec</span>
						<select bind:value={videoCodec}>
							<option value="h264">h.264 (universal)</option>
							<option value="h265">h.265 / hevc (smaller)</option>
							<option value="vp9">vp9</option>
						</select>
					</label>

					<label class="field">
						<span>downscale resolution</span>
						<select bind:value={videoResolution}>
							<option value="original">original</option>
							<option value="2160p">2160p (4k)</option>
							<option value="1440p">1440p (2k)</option>
							<option value="1080p">1080p (fhd)</option>
							<option value="720p">720p (hd)</option>
							<option value="480p">480p (sd)</option>
							<option value="360p">360p (compact)</option>
						</select>
					</label>

					<label class="field">
						<span>frame rate (fps)</span>
						<select bind:value={videoFps}>
							<option value={0}>original</option>
							<option value={60}>60 fps</option>
							<option value={30}>30 fps</option>
							<option value={24}>24 fps</option>
							<option value={15}>15 fps</option>
							<option value={10}>10 fps</option>
						</select>
					</label>

					<label class="field">
						<span>crf quality ({videoCrf})</span>
						<input type="range" min="14" max="36" bind:value={videoCrf} />
					</label>

					<label class="field">
						<span>target max mb (0=off)</span>
						<input type="number" min="0" step="1" placeholder="e.g. 8 or 25" bind:value={videoTargetMb} />
					</label>

					<label class="field">
						<span>trim start (s / hh:mm:ss)</span>
						<input type="text" placeholder="0.0" bind:value={videoTrimStart} />
					</label>

					<label class="field">
						<span>trim end (s / hh:mm:ss)</span>
						<input type="text" placeholder="end" bind:value={videoTrimEnd} />
					</label>

					<label class="field">
						<span>speed ({videoSpeed}x)</span>
						<input type="range" min="0.25" max="4.0" step="0.05" bind:value={videoSpeed} />
					</label>

					<label class="field">
						<span>audio gain ({videoGainDb} dB)</span>
						<input type="range" min="-20" max="20" step="1" bind:value={videoGainDb} />
					</label>

					<div class="field" style="grid-column: 1 / -1;">
						<span>rotate / flip</span>
						<div class="btn-group">
							<button type="button" class="btn-xs" onclick={() => (videoRotateDeg = (videoRotateDeg + 270) % 360)}>-90°</button>
							<button type="button" class="btn-xs" onclick={() => (videoRotateDeg = (videoRotateDeg + 90) % 360)}>+90°</button>
							<button type="button" class="btn-xs" onclick={() => (videoRotateDeg = (videoRotateDeg + 180) % 360)}>180°</button>
							<button type="button" class="btn-xs" class:on={videoFlipH} onclick={() => (videoFlipH = !videoFlipH)}>flip H</button>
							<button type="button" class="btn-xs" class:on={videoFlipV} onclick={() => (videoFlipV = !videoFlipV)}>flip V</button>
						</div>
					</div>
				</div>

				<div class="toggles-row">
					<label class="chk"><input type="checkbox" bind:checked={videoMute} /><span>strip audio</span></label>
					<label class="chk"><input type="checkbox" bind:checked={videoNormalize} /><span>loudnorm</span></label>
					<label class="chk"><input type="checkbox" bind:checked={videoGrayscale} /><span>grayscale</span></label>
					<label class="chk"><input type="checkbox" bind:checked={videoTranscribe} /><span>transcribe (whisper)</span></label>
					<label class="chk"><input type="checkbox" bind:checked={videoBurnSubs} /><span>burn-in subtitles</span></label>
				</div>

			{:else}
				<div class="panel-head">
					<span>audio parameters</span>
					<button
						type="button"
						class="btn-link"
						onclick={() => {
							audioTrimStart = '';
							audioTrimEnd = '';
							audioSpeed = 1.0;
							audioPitchSemitones = 0;
							audioGainDb = 0;
							audioFadeIn = 0;
							audioFadeOut = 0;
							audioNormalize = false;
							audioStripSilence = false;
							audioVoiceClean = false;
							audioReverse = false;
						}}
					>
						reset
					</button>
				</div>

				<div class="ctrl-grid">
					<label class="field">
						<span>format</span>
						<select bind:value={audioFormat}>
							<option value="mp3">mp3</option>
							<option value="wav">wav (pcm)</option>
							<option value="flac">flac (lossless)</option>
							<option value="m4a">m4a (aac)</option>
							<option value="ogg">ogg (vorbis)</option>
							<option value="opus">opus</option>
						</select>
					</label>

					<label class="field">
						<span>bitrate</span>
						<select bind:value={audioBitrate}>
							<option value="320k">320 kbps</option>
							<option value="256k">256 kbps</option>
							<option value="192k">192 kbps</option>
							<option value="128k">128 kbps</option>
							<option value="96k">96 kbps</option>
							<option value="64k">64 kbps (voice)</option>
						</select>
					</label>

					<label class="field">
						<span>sample rate</span>
						<select bind:value={audioSampleRate}>
							<option value={0}>original</option>
							<option value={48000}>48000 Hz</option>
							<option value={44100}>44100 Hz</option>
							<option value={22050}>22050 Hz</option>
							<option value={16000}>16000 Hz (whisper)</option>
						</select>
					</label>

					<label class="field">
						<span>channels</span>
						<select bind:value={audioChannels}>
							<option value={0}>original</option>
							<option value={2}>stereo (2ch)</option>
							<option value={1}>mono (1ch)</option>
						</select>
					</label>

					<label class="field">
						<span>trim start (s)</span>
						<input type="text" placeholder="0.0" bind:value={audioTrimStart} />
					</label>

					<label class="field">
						<span>trim end (s)</span>
						<input type="text" placeholder="end" bind:value={audioTrimEnd} />
					</label>

					<label class="field">
						<span>speed / tempo ({audioSpeed}x)</span>
						<input type="range" min="0.5" max="2.0" step="0.05" bind:value={audioSpeed} />
					</label>

					<label class="field">
						<span>pitch ({audioPitchSemitones > 0 ? `+${audioPitchSemitones}` : audioPitchSemitones} st)</span>
						<input type="range" min="-12" max="12" step="1" bind:value={audioPitchSemitones} />
					</label>

					<label class="field">
						<span>gain ({audioGainDb} dB)</span>
						<input type="range" min="-20" max="20" step="1" bind:value={audioGainDb} />
					</label>

					<label class="field">
						<span>fade in / out (s)</span>
						<div class="row">
							<input type="number" min="0" max="30" step="0.5" placeholder="in" bind:value={audioFadeIn} />
							<input type="number" min="0" max="30" step="0.5" placeholder="out" bind:value={audioFadeOut} />
						</div>
					</label>
				</div>

				<div class="toggles-row">
					<label class="chk"><input type="checkbox" bind:checked={audioNormalize} /><span>normalize</span></label>
					<label class="chk"><input type="checkbox" bind:checked={audioStripSilence} /><span>strip silence</span></label>
					<label class="chk"><input type="checkbox" bind:checked={audioVoiceClean} /><span>voice bandpass</span></label>
					<label class="chk"><input type="checkbox" bind:checked={audioReverse} /><span>reverse</span></label>
					<label class="chk"><input type="checkbox" bind:checked={audioTranscribe} /><span>transcribe (whisper)</span></label>
					<label class="chk"><input type="checkbox" bind:checked={audioGuitarTab} /><span>guitar -> tab</span></label>
				</div>
			{/if}
		</section>
	</div>

	<!-- Transcription / OCR / Guitar Tab Output Panel -->
	{#if activeTranscript || activeGuitarTab}
		<section class="panel">
			<div class="panel-head">
				<span>transcription output</span>
				<div class="row">
					<button
						type="button"
						class="btn-xs"
						onclick={() => navigator.clipboard.writeText(activeTranscript || activeGuitarTab)}
					>
						copy
					</button>
					{#if activeTranscript}
						<button type="button" class="btn-xs" onclick={() => downloadTextBlob(activeTranscript, 'transcript.txt')}>
							.txt
						</button>
					{/if}
					{#if activeSrt}
						<button type="button" class="btn-xs" onclick={() => downloadTextBlob(activeSrt, 'subtitles.srt')}>
							.srt
						</button>
					{/if}
					{#if activeVtt}
						<button type="button" class="btn-xs" onclick={() => downloadTextBlob(activeVtt, 'subtitles.vtt')}>
							.vtt
						</button>
					{/if}
					{#if activeGuitarTab}
						<button type="button" class="btn-xs" onclick={() => downloadTextBlob(activeGuitarTab, 'guitar_tab.md')}>
							.md tab
						</button>
					{/if}
				</div>
			</div>
			<textarea class="transcript-box" readonly value={activeGuitarTab || activeTranscript}></textarea>
		</section>
	{/if}

	<!-- Output Queue -->
	<section class="panel">
		<div class="panel-head">
			<span>outputs ({results.length})</span>
			{#if results.length > 0}
				<button type="button" class="btn-link" onclick={() => (results = [])}>clear</button>
			{/if}
		</div>

		{#if results.length === 0}
			<div class="empty">no converted files yet</div>
		{:else}
			<div class="table">
				{#each results as r (r.id)}
					<div class="trow">
						<a class="fname" href={r.downloadUrl} download={r.outputName} target="_blank">
							{r.outputName}
						</a>
						<span class="tag">{r.mediaType}</span>
						{#if r.dimensions}
							<span class="tag">{r.dimensions}</span>
						{/if}
						<span class="path">
							{formatBytes(r.origSize)} → {formatBytes(r.outSize)}
							{#if r.origSize > 0 && r.outSize > 0}
								({Math.round(((r.outSize - r.origSize) / r.origSize) * 100)}%)
							{/if}
						</span>
						<span class="meta">
							{r.engine}{r.elapsedSec ? ` · ${r.elapsedSec}s` : ''}
						</span>
						<a class="btn-xs accent-link" href={r.downloadUrl} download={r.outputName} target="_blank">
							save
						</a>
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>

<style>
	.wrap {
		max-width: 68rem;
		margin: 1.25rem auto 3rem auto;
		font-family: var(--mono-font);
		font-size: 0.82rem;
		color: #e4e4e7;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.topbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding-bottom: 0.55rem;
		border-bottom: 1px solid #ffffff1a;
	}

	.left,
	.right {
		display: flex;
		align-items: center;
		gap: 0.55rem;
	}

	.brand {
		color: #a1a1aa;
		text-decoration: none;
	}
	.brand:hover {
		color: #fff;
	}
	.sep {
		color: #52525b;
	}
	.current {
		color: #fff;
		font-weight: 600;
	}
	.msg {
		color: #9ffdd8;
	}

	.mini-select {
		padding: 0.18rem 0.45rem;
		font-size: 0.75rem;
		background: #18181b;
		border: 1px solid #27272a;
		color: #a1a1aa;
		border-radius: 4px;
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: #a1a1aa;
		background: #18181b;
		border: 1px solid #27272a;
		padding: 0.18rem 0.5rem;
		border-radius: 4px;
		font-size: 0.75rem;
	}
	.status.online {
		color: #e4e4e7;
		border-color: #9ffdd844;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #71717a;
	}
	.status.online .dot {
		background: #9ffdd8;
	}

	.mode-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.tabs {
		display: flex;
		gap: 0.35rem;
	}
	.tabs button {
		background: #18181b;
		color: #a1a1aa;
		border: 1px solid #27272a;
		border-radius: 4px;
		padding: 0.35rem 0.85rem;
		font-family: var(--mono-font);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.tabs button.active {
		background: #27272a;
		color: #9ffdd8;
		border-color: #9ffdd866;
		font-weight: 600;
	}

	.quick-actions {
		display: flex;
		gap: 0.45rem;
	}

	.main-grid {
		display: grid;
		grid-template-columns: 1fr 1.15fr;
		gap: 0.75rem;
	}
	@media (max-width: 820px) {
		.main-grid {
			grid-template-columns: 1fr;
		}
	}

	.panel {
		background: #18181b;
		border: 1px solid #27272a;
		border-radius: 6px;
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.panel-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-weight: 600;
		color: #a1a1aa;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.dropzone {
		border: 1px dashed #3f3f46;
		background: #121214;
		border-radius: 4px;
		padding: 1.6rem 0.75rem;
		text-align: center;
		color: #a1a1aa;
		cursor: pointer;
	}
	.dropzone.compact {
		padding: 0.55rem;
		font-size: 0.76rem;
	}
	.dropzone:hover,
	.dropzone.drag {
		border-color: #9ffdd8;
		color: #9ffdd8;
	}

	.stage {
		background: #09090b;
		border: 1px solid #27272a;
		border-radius: 4px;
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 210px;
		overflow: hidden;
		gap: 0.45rem;
	}
	.stage-img,
	.stage-video {
		max-width: 100%;
		max-height: 260px;
		object-fit: contain;
		transition: transform 0.15s ease;
	}
	.audio-stage {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.waveform {
		width: 100%;
		height: 72px;
		border-radius: 3px;
		border: 1px solid #27272a;
	}
	.stage-audio {
		width: 100%;
		height: 34px;
	}
	.stage-bar {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.stage-bar .muted {
		margin-right: auto;
	}

	.batch-strip {
		display: flex;
		gap: 0.35rem;
		overflow-x: auto;
		padding-bottom: 0.2rem;
	}
	.batch-pill {
		background: #121214;
		color: #a1a1aa;
		border: 1px solid #27272a;
		border-radius: 3px;
		padding: 0.2rem 0.5rem;
		font-family: var(--mono-font);
		font-size: 0.73rem;
		white-space: nowrap;
		cursor: pointer;
	}
	.batch-pill.selected {
		border-color: #9ffdd8;
		color: #9ffdd8;
	}

	.ctrl-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem 0.65rem;
	}
	@media (max-width: 520px) {
		.ctrl-grid {
			grid-template-columns: 1fr;
		}
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.74rem;
		color: #a1a1aa;
	}

	select,
	input[type='text'],
	input[type='number'],
	.input,
	.transcript-box {
		background: #121214;
		color: #e4e4e7;
		border: 1px solid #27272a;
		border-radius: 4px;
		padding: 0.3rem 0.5rem;
		font-family: var(--mono-font);
		font-size: 0.78rem;
		width: 100%;
		box-sizing: border-box;
	}

	input[type='range'] {
		width: 100%;
		accent-color: #9ffdd8;
	}

	.toggles-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem 0.85rem;
		padding-top: 0.25rem;
		border-top: 1px solid #27272a;
	}

	.chk {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.75rem;
		color: #d4d4d8;
		cursor: pointer;
	}
	.chk input {
		accent-color: #9ffdd8;
	}

	.btn-group,
	.row {
		display: flex;
		gap: 0.35rem;
		align-items: center;
	}

	.btn {
		background: #27272a;
		color: #e4e4e7;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		padding: 0.35rem 0.7rem;
		font-family: var(--mono-font);
		font-size: 0.78rem;
		cursor: pointer;
	}
	.btn:hover {
		border-color: #71717a;
	}
	.btn.accent {
		background: #9ffdd8;
		color: #09090b;
		border-color: #9ffdd8;
		font-weight: 600;
	}
	.btn.rec {
		border-color: #f87171;
		color: #f87171;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-xs {
		background: #121214;
		color: #d4d4d8;
		border: 1px solid #27272a;
		border-radius: 3px;
		padding: 0.2rem 0.45rem;
		font-family: var(--mono-font);
		font-size: 0.72rem;
		cursor: pointer;
		text-decoration: none;
	}
	.btn-xs:hover,
	.btn-xs.on {
		border-color: #9ffdd8;
		color: #9ffdd8;
	}
	.btn-xs.accent-link {
		background: #9ffdd81a;
		border-color: #9ffdd855;
		color: #9ffdd8;
	}

	.btn-link {
		background: none;
		border: none;
		color: #71717a;
		font-family: var(--mono-font);
		font-size: 0.74rem;
		cursor: pointer;
		padding: 0;
	}
	.btn-link:hover {
		color: #e4e4e7;
	}

	.transcript-box {
		min-height: 110px;
		resize: vertical;
		white-space: pre-wrap;
	}

	.muted {
		color: #71717a;
		font-weight: 400;
		text-transform: none;
	}

	.empty {
		color: #52525b;
		font-size: 0.78rem;
	}

	.table {
		display: flex;
		flex-direction: column;
	}
	.trow {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.38rem 0;
		border-top: 1px solid #27272a;
		flex-wrap: wrap;
	}
	.fname {
		color: #e4e4e7;
		text-decoration: none;
		font-weight: 500;
	}
	.fname:hover {
		color: #9ffdd8;
	}
	.tag {
		font-size: 0.7rem;
		padding: 0.05rem 0.38rem;
		border-radius: 3px;
		background: #27272a;
		color: #a1a1aa;
	}
	.path {
		color: #9ffdd8;
		font-size: 0.74rem;
	}
	.meta {
		margin-left: auto;
		color: #71717a;
		font-size: 0.73rem;
	}
</style>
