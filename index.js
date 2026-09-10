const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const cacheGrupos = new Map();

function salvarEmLog(categoria, dados) {
    const pastaLogs = path.join(__dirname, 'logs');
    if (!fs.existsSync(pastaLogs)) {
        fs.mkdirSync(pastaLogs, { recursive: true });
    }

    const caminhoArquivo = path.join(pastaLogs, `${categoria}.json`);
    let historico = [];

    if (fs.existsSync(caminhoArquivo)) {
        try {
            const conteudo = fs.readFileSync(caminhoArquivo, 'utf-8');
            historico = JSON.parse(conteudo);
        } catch (e) {
            historico = [];
        }
    }

    historico.push(dados);
    fs.writeFileSync(caminhoArquivo, JSON.stringify(historico, null, 2), 'utf-8');
}

async function obterNomeGrupo(sock, jid) {
    if (cacheGrupos.has(jid)) return cacheGrupos.get(jid);
    try {
        const metadata = await sock.groupMetadata(jid);
        if (metadata && metadata.subject) {
            cacheGrupos.set(jid, metadata.subject);
            return metadata.subject;
        }
    } catch (e) {}
    return jid;
}

async function obterIdentificadorContato(sock, jid, pushName = null) {
    if (!jid) return 'Desconhecido';

    if (jid.endsWith('@s.whatsapp.net')) {
        const numero = jid.split('@')[0];
        return pushName ? `${pushName} (${numero})` : numero;
    }

    if (jid.endsWith('@lid')) {
        try {
            const [resultado] = await sock.onWhatsApp(jid);
            if (resultado && resultado.jid) {
                const numeroReal = resultado.jid.split('@')[0];
                return pushName ? `${pushName} (${numeroReal})` : numeroReal;
            }
        } catch (e) {}
        return pushName ? `${pushName} [LID: ${jid.split('@')[0]}]` : jid.split('@')[0];
    }

    return jid;
}

// Extrai o nó interno de mensagens aninhadas (ViewOnce, Ephemeral, DeviceSent, etc.)
function desempacotarMensagem(msg) {
    if (!msg || !msg.message) return null;
    let m = msg.message;

    let alterou = true;
    while (alterou) {
        alterou = false;
        if (m?.deviceSentMessage?.message) { m = m.deviceSentMessage.message; alterou = true; }
        if (m?.ephemeralMessage?.message) { m = m.ephemeralMessage.message; alterou = true; }
        if (m?.viewOnceMessage?.message) { m = m.viewOnceMessage.message; alterou = true; }
        if (m?.viewOnceMessageV2?.message) { m = m.viewOnceMessageV2.message; alterou = true; }
        if (m?.viewOnceMessageV2Extension?.message) { m = m.viewOnceMessageV2Extension.message; alterou = true; }
        if (m?.documentWithCaptionMessage?.message) { m = m.documentWithCaptionMessage.message; alterou = true; }
    }

    return m;
}

function encontrarTipoMidia(conteudo) {
    if (!conteudo) return null;
    const tipos = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
    for (const tipo of tipos) {
        if (conteudo[tipo]) {
            return { tipoKey: tipo, mediaData: conteudo[tipo] };
        }
    }
    return null;
}

// Tenta baixar a mídia usando dois métodos sequenciais
async function processarMidia(sock, msg, conteudoDesempacotado) {
    const infoMidia = encontrarTipoMidia(conteudoDesempacotado);
    if (!infoMidia) return null;

    const pastaMidias = path.join(__dirname, 'midias');
    if (!fs.existsSync(pastaMidias)) {
        fs.mkdirSync(pastaMidias, { recursive: true });
    }

    const tipoExtracao = infoMidia.tipoKey.replace('Message', '');
    const mimetype = infoMidia.mediaData?.mimetype || 'application/octet-stream';
    const extensao = mime.extension(mimetype) || 'bin';
    const nomeArquivo = `${msg.key.id}.${extensao}`;
    const caminhoCompleto = path.join(pastaMidias, nomeArquivo);

    // Método 1: downloadMediaMessage com reuploadRequest do sock
    try {
        const msgSintetica = {
            key: msg.key,
            message: { [infoMidia.tipoKey]: infoMidia.mediaData }
        };

        const buffer = await downloadMediaMessage(
            msgSintetica,
            'buffer',
            {},
            {
                logger: pino({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage
            }
        );

        if (buffer && buffer.length > 0) {
            fs.writeFileSync(caminhoCompleto, buffer);
            return { tipoMidia: tipoExtracao, caminhoArquivo: caminhoCompleto, nomeArquivo };
        }
    } catch (e1) {
        // Método 2: Download direto via stream se o Método 1 falhar
        try {
            const stream = await downloadContentFromMessage(infoMidia.mediaData, tipoExtracao);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }

            if (buffer && buffer.length > 0) {
                fs.writeFileSync(caminhoCompleto, buffer);
                return { tipoMidia: tipoExtracao, caminhoArquivo: caminhoCompleto, nomeArquivo };
            }
        } catch (e2) {
            return { erro: `Falha ao baixar mídia (${e2.message})` };
        }
    }

    return { erro: 'O arquivo de mídia retornou vazio' };
}

async function iniciarBotGuarda() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Escaneie o QR Code abaixo no seu WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Reconectando...', shouldReconnect);
            if (shouldReconnect) {
                iniciarBotGuarda();
            }
        } else if (connection === 'open') {
            console.log('Bot de guarda conectado e monitorando!\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        for (const msg of messages) {
            try {
                const jid = msg.key.remoteJid;
                if (!jid || jid === 'status@broadcast') continue;

                const conteudoReal = desempacotarMensagem(msg);
                if (!conteudoReal) continue;

                const ehViewOnce = Boolean(
                    msg.message?.viewOnceMessage || 
                    msg.message?.viewOnceMessageV2 || 
                    msg.message?.viewOnceMessageV2Extension ||
                    msg.message?.deviceSentMessage?.message?.viewOnceMessage ||
                    msg.message?.deviceSentMessage?.message?.viewOnceMessageV2
                );

                const tempoExpiracao = conteudoReal?.extendedTextMessage?.contextInfo?.expiration ||
                                      conteudoReal?.imageMessage?.contextInfo?.expiration ||
                                      conteudoReal?.videoMessage?.contextInfo?.expiration ||
                                      msg.expiration || null;

                const ehTemporaria = ehViewOnce || Boolean(tempoExpiracao);
                const ehMinha = msg.key.fromMe;
                const ehGrupo = jid.endsWith('@g.us');
                const tipoOrigem = ehGrupo ? 'GRUPO' : 'PRIVADO';

                const meuNumero = sock.user?.id ? sock.user.id.split(':')[0] : 'Você';
                const meuNome = sock.user?.name || 'Você';
                const identificadorMeu = `${meuNome} (${meuNumero})`;

                let de = '';
                let para = '';

                if (ehGrupo) {
                    const nomeGrupo = await obterNomeGrupo(sock, jid);
                    const remetenteGrupo = msg.key.participant || jid;
                    de = ehMinha ? identificadorMeu : await obterIdentificadorContato(sock, remetenteGrupo, msg.pushName);
                    para = `Grupo: ${nomeGrupo} (${jid})`;
                } else {
                    if (ehMinha) {
                        de = identificadorMeu;
                        para = await obterIdentificadorContato(sock, jid, null);
                    } else {
                        de = await obterIdentificadorContato(sock, jid, msg.pushName);
                        para = identificadorMeu;
                    }
                }

                const infoMidia = encontrarTipoMidia(conteudoReal);
                const texto = conteudoReal?.conversation || 
                              conteudoReal?.extendedTextMessage?.text || 
                              conteudoReal?.imageMessage?.caption || 
                              conteudoReal?.videoMessage?.caption || 
                              conteudoReal?.documentMessage?.caption || 
                              (infoMidia ? `[Mídia: ${infoMidia.tipoKey.replace('Message', '')}]` : '[Sem texto/legenda]');

                const horario = new Date((msg.messageTimestamp || Date.now() / 1000) * 1000).toLocaleString('pt-BR');

                // Executa o download passando a instância do socket
                const dadosMidia = await processarMidia(sock, msg, conteudoReal);

                const registro = {
                    dataHora: horario,
                    direcao: ehMinha ? 'ENVIADA' : 'RECEBIDA',
                    tipo: tipoOrigem,
                    ehTemporaria: ehTemporaria,
                    ehVisualizacaoUnica: ehViewOnce,
                    de: de,
                    para: para,
                    mensagem: texto,
                    midia: dadosMidia || 'Nenhuma'
                };

                console.log(`========================================`);
                console.log(`[${tipoOrigem}] | [${ehMinha ? 'ENVIADA' : 'RECEBIDA'}]`);
                if (ehViewOnce) {
                    console.log(`⚠️ ALERTA: MÍDIA DE VISUALIZAÇÃO ÚNICA!`);
                }
                if (tempoExpiracao) {
                    console.log(`⏳ MENSAGEM TEMPORÁRIA (Expira em: ${tempoExpiracao / 86400} dia(s))`);
                }
                console.log(`Data/Hora : ${horario}`);
                console.log(`De        : ${de}`);
                console.log(`Para      : ${para}`);
                console.log(`Conteúdo  : ${texto}`);

                if (dadosMidia && dadosMidia.nomeArquivo) {
                    console.log(`Mídia Salva: ${dadosMidia.nomeArquivo}`);
                } else if (dadosMidia && dadosMidia.erro) {
                    console.log(`Status Mídia: ${dadosMidia.erro}`);
                }

                console.log(`========================================\n`);

                if (ehGrupo) {
                    salvarEmLog('mensagens_grupos', registro);
                } else {
                    salvarEmLog('mensagens_privadas', registro);
                }
            } catch (errLoop) {
                console.error('Erro ao processar mensagem:', errLoop.message);
            }
        }
    });
}

iniciarBotGuarda();