<script lang="ts">
	import { onMount } from 'svelte';

	interface DeviceInfo {
		online: boolean;
		last_heartbeat: number;
		tunnel_url: string;
		gpu_status: string;
		hostname: string;
		shared_clipboard: string;
		clipboard_source: string;
		clipboard_updated_at: number;
	}

	interface CosmoDrop {
		id: string;
		filename: string;
		mime_type: string;
		category: string;
		course_hint: string;
		auto_route: number;
		note_text: string;
		size_bytes: number;
		status: string;
		routed_to: string;
		badge: string;
		summary: string;
		created_at: number;
		synced_at: number;
	}

	let device = $state<DeviceInfo>({
		online: false,
		last_heartbeat: 0,
		tunnel_url: '',
		gpu_status: '',
		hostname: 'ryan-nixos',
		shared_clipboard: '',
		clipboard_source: '',
		clipboard_updated_at: 0
	});

	let drops = $state<CosmoDrop[]>([]);
	let courseHint = $state('auto');
	let autoRoute = $state(true);
	let noteCaption = $state('');
	let voiceAudioB64 = $state('');
	let isRecordingVoice = $state(false);
	let voiceSeconds = $state(0);
	let clipboardInput = $state('');
	let clipboardDirty = $state(false);
	let uploading = $state(false);
	let uploadProgress = $state('');
	let statusMsg = $state('');
	let dragActive = $state(false);

	let fileInputEl: HTMLInputElement | undefined = $state();
	let cameraInputEl: HTMLInputElement | undefined = $state();
	let mediaRecorder: MediaRecorder | null = null;
	let speechRec: any = null;
	let voiceTimer: any = null;
	let voiceChunks: BlobPart[] = [];

	async function toggleVoiceHint() {
		if (isRecordingVoice) {
			if (mediaRecorder && mediaRecorder.state !== 'inactive') {
				mediaRecorder.stop();
			}
			if (speechRec) {
				try {
					speechRec.stop();
				} catch {}
			}
			if (voiceTimer) clearInterval(voiceTimer);
			isRecordingVoice = false;
			return;
		}

		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			voiceChunks = [];
			voiceAudioB64 = '';
			voiceSeconds = 0;

			const opts: MediaRecorderOptions = { audioBitsPerSecond: 16000 };
			mediaRecorder = new MediaRecorder(stream, opts);
			mediaRecorder.ondataavailable = (e) => {
				if (e.data && e.data.size > 0) voiceChunks.push(e.data);
			};
			mediaRecorder.onstop = async () => {
				stream.getTracks().forEach((t) => t.stop());
				if (voiceChunks.length > 0) {
					const blob = new Blob(voiceChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
					const buf = await blob.arrayBuffer();
					const bytes = new Uint8Array(buf);
					let bin = '';
					const chunk = 0x8000;
					for (let i = 0; i < bytes.length; i += chunk) {
						bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
					}
					voiceAudioB64 = btoa(bin);
					statusMsg = `voice attached (${voiceSeconds}s)`;
				}
			};
			mediaRecorder.start(250);
			isRecordingVoice = true;
			voiceTimer = setInterval(() => {
				voiceSeconds += 1;
				if (voiceSeconds >= 25 && isRecordingVoice) {
					toggleVoiceHint();
				}
			}, 1000);

			const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
			if (SR) {
				try {
					speechRec = new SR();
					speechRec.continuous = true;
					speechRec.interimResults = true;
					speechRec.lang = 'en-US';
					const baseText = noteCaption ? noteCaption + ' ' : '';
					speechRec.onresult = (event: any) => {
						let transcript = '';
						for (let i = 0; i < event.results.length; i++) {
							transcript += event.results[i][0].transcript;
						}
						if (transcript.trim()) {
							noteCaption = (baseText + transcript.trim()).trim();
						}
					};
					speechRec.start();
				} catch {}
			}
		} catch (err: any) {
			statusMsg = `mic error: ${err?.message || err}`;
			isRecordingVoice = false;
		}
	}

	async function fetchState() {
		try {
			const res = await fetch('/cosmo/api?action=state', { cache: 'no-store' });
			if (!res.ok) return;
			const data = await res.json();
			if (data.ok) {
				device = data.device;
				drops = data.drops || [];
				if (!clipboardDirty && data.device?.shared_clipboard !== undefined) {
					clipboardInput = data.device.shared_clipboard;
				}
			}
		} catch {
			// ignore
		}
	}

	onMount(() => {
		fetchState();
		const timer = setInterval(fetchState, 3500);
		return () => clearInterval(timer);
	});

	function formatBytes(bytes: number): string {
		if (!bytes || bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}

	function formatTimeAgo(ts: number): string {
		if (!ts) return 'never';
		const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
		if (diffSec < 10) return 'now';
		if (diffSec < 60) return `${diffSec}s`;
		if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
		if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
		return new Date(ts).toLocaleDateString();
	}

	async function compressImageIfNeeded(
		file: File
	): Promise<{ b64: string; mime: string; size: number; name: string }> {
		const isImage = file.type.startsWith('image/') && !file.type.includes('svg');
		if (!isImage) {
			const buf = await file.arrayBuffer();
			const bytes = new Uint8Array(buf);
			let bin = '';
			const chunk = 0x8000;
			for (let i = 0; i < bytes.length; i += chunk) {
				bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
			}
			return {
				b64: btoa(bin),
				mime: file.type || 'application/octet-stream',
				size: buf.byteLength,
				name: file.name
			};
		}

		return new Promise((resolve) => {
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = () => {
				URL.revokeObjectURL(url);
				const maxDim = 2200;
				let w = img.naturalWidth || img.width;
				let h = img.naturalHeight || img.height;
				if (w > maxDim || h > maxDim) {
					const scale = maxDim / Math.max(w, h);
					w = Math.round(w * scale);
					h = Math.round(h * scale);
				}
				const canvas = document.createElement('canvas');
				canvas.width = w;
				canvas.height = h;
				const ctx = canvas.getContext('2d');
				if (ctx) {
					ctx.drawImage(img, 0, 0, w, h);
					const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
					const b64 = dataUrl.split(',')[1] || '';
					const approxBytes = Math.floor((b64.length * 3) / 4);
					const cleanName = file.name.replace(/\.(heic|heif|png|webp)$/i, '.jpg');
					resolve({
						b64,
						mime: 'image/jpeg',
						size: approxBytes,
						name: cleanName
					});
				} else {
					resolve({ b64: '', mime: file.type, size: file.size, name: file.name });
				}
			};
			img.onerror = async () => {
				URL.revokeObjectURL(url);
				const buf = await file.arrayBuffer();
				const bytes = new Uint8Array(buf);
				let bin = '';
				const chunk = 0x8000;
				for (let i = 0; i < bytes.length; i += chunk) {
					bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
				}
				resolve({
					b64: btoa(bin),
					mime: file.type || 'image/jpeg',
					size: buf.byteLength,
					name: file.name
				});
			};
			img.src = url;
		});
	}

	async function handleFiles(fileList: FileList | null) {
		if (!fileList || fileList.length === 0) return;
		uploading = true;
		statusMsg = '';
		const files = Array.from(fileList);

		try {
			for (let i = 0; i < files.length; i++) {
				const f = files[i];
				uploadProgress = `${i + 1}/${files.length}: ${f.name}`;
				const prepared = await compressImageIfNeeded(f);

				const combinedNotePayload = voiceAudioB64
					? `${noteCaption.trim()}||voice_b64:${voiceAudioB64}`
					: noteCaption.trim();

				const res = await fetch('/cosmo/api', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'upload',
						filename: prepared.name,
						mime_type: prepared.mime,
						category: prepared.mime.startsWith('image/') ? 'note_photo' : 'file',
						course_hint: courseHint,
						auto_route: autoRoute,
						note_text: combinedNotePayload,
						data_b64: prepared.b64,
						size_bytes: prepared.size
					})
				});
				const out = await res.json();
				if (!out.ok) throw new Error(out.error || 'upload failed');
			}

			noteCaption = '';
			voiceAudioB64 = '';
			statusMsg = `uploaded ${files.length} file(s)`;
			await fetchState();
		} catch (err: any) {
			statusMsg = `error: ${err?.message || err}`;
		} finally {
			uploading = false;
			uploadProgress = '';
			if (fileInputEl) fileInputEl.value = '';
			if (cameraInputEl) cameraInputEl.value = '';
		}
	}

	async function sendClipboard() {
		try {
			const res = await fetch('/cosmo/api', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'clipboard',
					text: clipboardInput,
					source: 'web_device'
				})
			});
			const data = await res.json();
			if (data.ok) {
				clipboardDirty = false;
				statusMsg = 'clipboard pushed';
				await fetchState();
			}
		} catch (err: any) {
			statusMsg = `error: ${err?.message || err}`;
		}
	}

	async function copySharedClipboard() {
		try {
			await navigator.clipboard.writeText(clipboardInput || '');
			statusMsg = 'copied';
		} catch {
			statusMsg = 'copy failed';
		}
	}

	async function deleteDrop(id: string) {
		await fetch('/cosmo/api', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'delete', id })
		});
		await fetchState();
	}
</script>

<svelte:head>
	<title>cosmo</title>
</svelte:head>

<div class="wrap">
	<header class="topbar">
		<div class="left">
			<a href="/" class="brand">peckhamr.com</a>
			<span class="sep">/</span>
			<span class="current">cosmo</span>
		</div>
		<div class="right">
			{#if statusMsg}
				<span class="msg">{statusMsg}</span>
			{/if}
			<span class="status" class:online={device.online}>
				<span class="dot"></span>
				{device.hostname}: {device.online ? 'online' : `offline (${formatTimeAgo(device.last_heartbeat)})`}
			</span>
			{#if device.tunnel_url && device.online}
				<a class="link" href="{device.tunnel_url}/mobile" target="_blank">tunnel</a>
			{/if}
		</div>
	</header>

	<div class="grid">
		<section class="panel">
			<div class="panel-head">
				<span>upload</span>
				<div class="inline-opts">
					<select bind:value={courseHint} aria-label="course">
						<option value="auto">class: auto</option>
						<option value="stats">stats</option>
						<option value="quantum">quantum</option>
						<option value="physics">physics</option>
						<option value="german">german</option>
					</select>
					<label class="chk">
						<input type="checkbox" bind:checked={autoRoute} />
						<span>route</span>
					</label>
				</div>
			</div>

			<input
				type="file"
				accept="image/*"
				capture="environment"
				style="display:none"
				bind:this={cameraInputEl}
				onchange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
			/>
			<input
				type="file"
				accept="image/*,application/pdf,.wav,.mp3,.m4a,.tex,.md,.txt,.zip"
				multiple
				style="display:none"
				bind:this={fileInputEl}
				onchange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
			/>

			<div
				class="drop"
				class:drag={dragActive}
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
					handleFiles(e.dataTransfer?.files || null);
				}}
				onclick={() => fileInputEl?.click()}
				onkeydown={(e) => e.key === 'Enter' && fileInputEl?.click()}
			>
				{uploading ? uploadProgress || 'uploading...' : 'drop files or click to select'}
			</div>

			<div class="row">
				<input
					type="text"
					class="input"
					placeholder={voiceAudioB64 ? 'voice attached (optional text)' : 'hint / topic (optional)'}
					bind:value={noteCaption}
				/>
				<button
					type="button"
					class="btn"
					class:rec={isRecordingVoice}
					class:has-voice={!isRecordingVoice && !!voiceAudioB64}
					disabled={uploading}
					onclick={toggleVoiceHint}
				>
					{isRecordingVoice ? `stop (${voiceSeconds}s)` : voiceAudioB64 ? 'voice*' : 'voice'}
				</button>
				<button type="button" class="btn accent" disabled={uploading} onclick={() => cameraInputEl?.click()}>
					camera
				</button>
				<button type="button" class="btn" disabled={uploading} onclick={() => fileInputEl?.click()}>
					files
				</button>
			</div>
		</section>

		<section class="panel">
			<div class="panel-head">
				<span>clipboard</span>
				<span class="muted">
					{device.clipboard_updated_at ? formatTimeAgo(device.clipboard_updated_at) : ''}
				</span>
			</div>

			<textarea
				class="textarea"
				placeholder="shared text / url"
				bind:value={clipboardInput}
				oninput={() => (clipboardDirty = true)}
			></textarea>

			<div class="row">
				<button type="button" class="btn accent" onclick={sendClipboard}>push</button>
				<button type="button" class="btn" onclick={copySharedClipboard}>copy</button>
			</div>
		</section>
	</div>

	<section class="panel">
		<div class="panel-head">
			<span>queue ({drops.length})</span>
			<button type="button" class="btn-link" onclick={fetchState}>refresh</button>
		</div>

		{#if drops.length === 0}
			<div class="empty">empty</div>
		{:else}
			<div class="table">
				{#each drops as d (d.id)}
					<div class="trow">
						<a
							class="fname"
							href="/cosmo/api?action=download&id={encodeURIComponent(d.id)}"
							target="_blank"
						>
							{d.filename}
						</a>
						<span class="tag" class:ok={d.status === 'routed'} class:sync={d.status === 'synced'}>
							{d.status}
						</span>
						{#if d.routed_to}
							<span class="path">{d.routed_to}</span>
						{:else if d.badge}
							<span class="path">{d.badge}</span>
						{/if}
						<span class="meta">{formatBytes(d.size_bytes)} · {formatTimeAgo(d.created_at)}</span>
						<button type="button" class="del" onclick={() => deleteDrop(d.id)}>del</button>
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>

<style>
	.wrap {
		max-width: 56rem;
		margin: 1.5rem auto 3rem auto;
		font-family: var(--mono-font);
		font-size: 0.85rem;
		color: #e4e4e7;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.topbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding-bottom: 0.65rem;
		border-bottom: 1px solid #ffffff1a;
	}

	.left,
	.right {
		display: flex;
		align-items: center;
		gap: 0.65rem;
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

	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: #a1a1aa;
		background: #18181b;
		border: 1px solid #27272a;
		padding: 0.2rem 0.55rem;
		border-radius: 4px;
		font-size: 0.78rem;
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

	.link {
		color: #9ffdd8;
		font-size: 0.78rem;
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.85rem;
	}
	@media (max-width: 720px) {
		.grid {
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
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.inline-opts {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		text-transform: none;
		font-weight: 400;
	}

	select,
	.input,
	.textarea {
		background: #121214;
		color: #e4e4e7;
		border: 1px solid #27272a;
		border-radius: 4px;
		padding: 0.35rem 0.55rem;
		font-family: var(--mono-font);
		font-size: 0.82rem;
		box-sizing: border-box;
	}

	.chk {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.78rem;
		color: #a1a1aa;
		cursor: pointer;
	}

	.drop {
		border: 1px dashed #3f3f46;
		background: #121214;
		border-radius: 4px;
		padding: 1.35rem 0.75rem;
		text-align: center;
		color: #a1a1aa;
		cursor: pointer;
	}
	.drop:hover,
	.drop.drag {
		border-color: #9ffdd8;
		color: #9ffdd8;
	}

	.textarea {
		width: 100%;
		min-height: 92px;
		resize: vertical;
	}

	.row {
		display: flex;
		gap: 0.45rem;
	}
	.row .input {
		flex: 1;
		min-width: 0;
	}

	.btn {
		background: #27272a;
		color: #e4e4e7;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		padding: 0.4rem 0.75rem;
		font-family: var(--mono-font);
		font-size: 0.8rem;
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
	.btn.has-voice {
		border-color: #9ffdd8;
		color: #9ffdd8;
	}

	.btn-link,
	.del {
		background: none;
		border: none;
		color: #71717a;
		font-family: var(--mono-font);
		font-size: 0.76rem;
		cursor: pointer;
		padding: 0;
	}
	.btn-link:hover {
		color: #e4e4e7;
	}
	.del:hover {
		color: #f87171;
	}

	.muted {
		color: #71717a;
		font-weight: 400;
		text-transform: none;
	}

	.empty {
		color: #52525b;
		font-size: 0.8rem;
	}

	.table {
		display: flex;
		flex-direction: column;
	}

	.trow {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.4rem 0;
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
		font-size: 0.72rem;
		padding: 0.05rem 0.4rem;
		border-radius: 3px;
		background: #27272a;
		color: #a1a1aa;
	}
	.tag.sync {
		color: #38bdf8;
	}
	.tag.ok {
		color: #9ffdd8;
	}

	.path {
		color: #9ffdd8;
		font-size: 0.76rem;
	}

	.meta {
		margin-left: auto;
		color: #71717a;
		font-size: 0.75rem;
	}
</style>
