const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

// Função auxiliar para salvar os registros em arquivos JSON
function salvarEmLog(categoria, dados) {
    const pastaLogs = path.join(__dirname, 'logs');
    if (!fs.existsSync(pastaLogs)) {
        fs.mkdirSync(pastaLogs);
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

// Função para identificar e converter LID ou JID em Número / Nome
async function obterIdentificadorContato(sock, jid, msg) {
    if (!jid) return 'Desconhecido';

    // 1. Tenta extrair o nome push (Nome do perfil que a pessoa colocou no WhatsApp)
    const nomePerfil = msg?.pushName;

    // 2. Se o JID for do formato padrão (@s.whatsapp.net), extrai apenas os números (número do celular)
    if (jid.endsWith('@s.whatsapp.net')) {
        const numero = jid.split('@')[0];
        return nomePerfil ? `${nomePerfil} (${numero})` : numero;
    }

    // 3. Se for LID (@lid), tenta converter para o número real usando o gerenciador de contatos do Baileys
    if (jid.endsWith('@lid')) {
        try {
            // Tenta consultar o número associado ao LID no servidor do WhatsApp
            const [resultado] = await sock.onWhatsApp(jid);
            if (resultado && resultado.jid) {
                const numeroReal = resultado.jid.split('@')[0];
                return nomePerfil ? `${nomePerfil} (${numeroReal})` : numeroReal;
            }
        } catch (e) {
            // Caso falhe a consulta no servidor
        }
        
        // Se houver nome de perfil salvo na mensagem, exibe o nome + o ID
        if (nomePerfil) {
            return `${nomePerfil} [LID: ${jid.split('@')[0]}]`;
        }
    }

    return jid;
}

// Função para extrair e baixar qualquer tipo de mídia (Normal, Temporária ou View Once)
async function processarMidia(msg) {
    if (!msg.message) return null;

    // 1. Desempacota as camadas do protocolo WhatsApp (Ephemeral / ViewOnce V1 / ViewOnce V2)
    let conteudo = msg.message;

    if (conteudo.ephemeralMessage) {
        conteudo = conteudo.ephemeralMessage.message;
    }
    if (conteudo.viewOnceMessage) {
        conteudo = conteudo.viewOnceMessage.message;
    } else if (conteudo.viewOnceMessageV2) {
        conteudo = conteudo.viewOnceMessageV2.message;
    } else if (conteudo.viewOnceMessageV2Extension) {
        conteudo = conteudo.viewOnceMessageV2Extension.message;
    }

    if (!conteudo) return null;

    // 2. Identifica o tipo de chave de mídia presente
    const tipoMensagem = Object.keys(conteudo)[0];
    const tiposSuportados = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];

    if (!tiposSuportados.includes(tipoMensagem)) {
        return null; // Não contém mídia
    }

    try {
        // Cria a pasta 'midias' imediatamente antes de tentar salvar
        const pastaMidias = path.join(__dirname, 'midias');
        if (!fs.existsSync(pastaMidias)) {
            fs.mkdirSync(pastaMidias, { recursive: true });
        }

        // Reconstrói uma estrutura sintética para o downloadMediaMessage conseguir processar o nó interno
        const mensagemParaDownload = {
            key: msg.key,
            message: conteudo
        };

        // 3. Faz o download do buffer
        const buffer = await downloadMediaMessage(
            mensagemParaDownload,
            'buffer',
            {},
            { 
                logger: pino({ level: 'silent' }),
                reuploadRequest: () => Promise.resolve()
            }
        );

        if (!buffer) return null;

        // 4. Identifica a extensão e grava o arquivo
        const dadosMidia = conteudo[tipoMensagem];
        const mimetype = dadosMidia?.mimetype || 'application/octet-stream';
        const extensao = mime.extension(mimetype) || 'bin';

        const nomeArquivo = `${msg.key.id}.${extensao}`;
        const caminhoCompleto = path.join(pastaMidias, nomeArquivo);

        fs.writeFileSync(caminhoCompleto, buffer);

        return {
            tipoMidia: tipoMensagem.replace('Message', ''),
            caminhoArquivo: caminhoCompleto,
            nomeArquivo: nomeArquivo
        };
    } catch (erro) {
        console.error('Erro ao processar/baixar mídia:', erro.message);
        return { erro: erro.message };
    }
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

    // ESCUTA DE MENSAGENS
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            const jid = msg.key.remoteJid;
            if (!jid || jid === 'status@broadcast') continue;

            // Detecção de Mensagem Temporária e View Once
            const ehViewOnce = Boolean(
                msg.message?.viewOnceMessage || 
                msg.message?.viewOnceMessageV2 || 
                msg.message?.viewOnceMessageV2Extension
            );

            const tempoExpiracao = msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.expiration ||
                                  msg.message?.extendedTextMessage?.contextInfo?.expiration ||
                                  msg.expiration || null;

            const ehTemporaria = ehViewOnce || Boolean(tempoExpiracao);

            const ehMinha = msg.key.fromMe;
            const direcao = ehMinha ? 'ENVIADA (Por você)' : 'RECEBIDA';
            const ehGrupo = jid.endsWith('@g.us');
            const tipoOrigem = ehGrupo ? 'GRUPO' : 'PRIVADO';

            // Resolução do Número/Contato
            const contatoIdentificado = await obterIdentificadorContato(sock, jid, msg);

            // Desempacota o texto
            let conteudoMensagem = msg.message;
            if (conteudoMensagem?.ephemeralMessage) conteudoMensagem = conteudoMensagem.ephemeralMessage.message;
            if (conteudoMensagem?.viewOnceMessage) conteudoMensagem = conteudoMensagem.viewOnceMessage.message;
            if (conteudoMensagem?.viewOnceMessageV2) conteudoMensagem = conteudoMensagem.viewOnceMessageV2.message;

            const texto = conteudoMensagem?.conversation || 
                          conteudoMensagem?.extendedTextMessage?.text || 
                          conteudoMensagem?.imageMessage?.caption || 
                          conteudoMensagem?.videoMessage?.caption || 
                          '[Sem texto/legenda]';

            const horario = new Date((msg.messageTimestamp || Date.now() / 1000) * 1000).toLocaleString('pt-BR');
            const remetenteEspecifico = msg.key.participant ? await obterIdentificadorContato(sock, msg.key.participant, msg) : contatoIdentificado;

            const dadosMidia = await processarMidia(msg);

            const registro = {
                dataHora: horario,
                direcao: direcao,
                tipo: tipoOrigem,
                ehTemporaria: ehTemporaria,
                ehVisualizacaoUnica: ehViewOnce,
                chat: contatoIdentificado,
                idRaw: jid,
                remetente: remetenteEspecifico,
                mensagem: texto,
                midia: dadosMidia || 'Nenhuma'
            };

            // EXIBIÇÃO FORMATADA NO TERMINAL
            console.log(`========================================`);
            console.log(`[${tipoOrigem}] | [${direcao}]`);
            if (ehViewOnce) {
                console.log(`⚠️ ALERTA: MÍDIA DE VISUALIZAÇÃO ÚNICA!`);
            }
            if (tempoExpiracao) {
                console.log(`⏳ MENSAGEM TEMPORÁRIA (Expira em: ${tempoExpiracao / 86400} dia(s))`);
            }
            console.log(`Data/Hora : ${horario}`);
            console.log(`Contato   : ${contatoIdentificado}`);
            console.log(`Conteúdo  : ${texto}`);
            if (dadosMidia) {
                console.log(`Mídia Salva: ${dadosMidia.nomeArquivo || 'Erro ao salvar'}`);
            }
            console.log(`========================================\n`);

            if (ehGrupo) {
                salvarEmLog('mensagens_grupos', registro);
            } else {
                salvarEmLog('mensagens_privadas', registro);
            }
        }
    });
}

iniciarBotGuarda();