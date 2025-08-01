require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo .env
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs'); // Usado apenas para checar se o PDF existe
const path = require('path');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

//...
const app = express();

// 1. Servir arquivos estáticos (CSS, imagens, etc.) da pasta raiz PRIMEIRO
app.use(express.static(path.join(__dirname, '')));

// 2. Configurações de body-parser e CORS
app.use(cors());
app.use(express.json());


// --- ROTAS DA API COM SUPABASE ---
// (As suas rotas como /create-payment-apostila, /check-status, etc. vêm aqui)
app.post('/create-payment-apostila', async (req, res) => {
  //... seu código da rota
});

// ...outras rotas da API...


// 3. Rota "catch-all" no FINAL para servir o app principal
// Esta rota só será acionada se nenhuma rota da API acima corresponder.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'apostila.html'));
});

// Rota principal para servir o arquivo HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'apostila.html'));
});

// --- ARQUIVOS E PREÇO ---
const APOSTILA_FILE_PATH = path.join(__dirname, 'apostila.pdf');
const APOSTILA_PRICE = 19.90;

// --- CONFIGURAÇÕES DE SERVIÇOS (USAR VARIÁVEIS DE AMBIENTE EM PRODUÇÃO) ---
const MERCADO_PAGO_TOKEN = process.env.MERCADO_PAGO_TOKEN;
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3001'; // Fallback para dev local
const EMAIL_CONFIG = {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
};
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// --- INICIALIZAÇÃO DOS CLIENTES ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: EMAIL_CONFIG.user, pass: EMAIL_CONFIG.pass },
});

// --- FUNÇÃO DE ENVIO DE E-MAIL COM APOSTILA ---
async function sendApostilaEmail(sale) {
    try {
        if (!fs.existsSync(APOSTILA_FILE_PATH)) {
            console.error("ERRO CRÍTICO: Arquivo da apostila (apostila.pdf) não encontrado no servidor.");
            return;
        }

        await transporter.sendMail({
            from: `"Projeto NST TREINAMENTO" <${EMAIL_CONFIG.user}>`,
            to: sale.email,
            subject: "Sua Apostila chegou! - Módulo I: Luto Mal Resolvido",
            html: `
                <div style="font-family: Arial, sans-serif; color: #333;">
                    <h1 style="color: #0D1B2A;">Olá, ${sale.name}!</h1>
                    <p>Obrigado por sua compra! Sua apostila do <strong>MÓDULO 1 - LUTO MAL RESOLVIDO</strong> está em anexo neste e-mail.</p>
                    <p>Bons estudos!</p>
                    <br>
                    <p>Atenciosamente,</p>
                    <p>Equipe NST TREINAMENTO</p>
                    <hr>
                    <p style="font-size: 0.8em; color: #888;">
                        Caso tenha problemas para abrir o arquivo ou não o tenha recebido corretamente, por favor, entre em contato respondendo a este e-mail ou enviando uma mensagem para: <a href="mailto:nilsonsantosterapeuta@gmail.com">nilsonsantosterapeuta@gmail.com</a>
                        <br>
                        <em>Este é um e-mail automático, por favor, não responda diretamente.</em>
                    </p>
                </div>
            `,
            attachments: [{
                filename: 'Apostila - Luto Mal Resolvido.pdf',
                path: APOSTILA_FILE_PATH,
                contentType: 'application/pdf'
            }]
        });
        console.log(`✉️ Apostila enviada com sucesso para ${sale.email}`);
    } catch (error) {
        console.error(`Falha ao enviar e-mail com apostila para ${sale.email}:`, error);
    }
}

// --- ROTAS DA API COM SUPABASE ---

app.post('/create-payment-apostila', async (req, res) => {
    if (!MERCADO_PAGO_TOKEN || !PUBLIC_URL || !SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: "O servidor não está configurado corretamente." });
    }
    const { fullName, email, cpf } = req.body;
    if (!fullName || !email || !cpf) {
        return res.status(400).json({ error: "Dados incompletos." });
    }
    const nameParts = fullName.trim().split(' ');
    const firstName = nameParts.shift();
    const lastName = nameParts.join(' ');
    const cleanedCpf = cpf.replace(/[^\d]/g, "");

    const newSale = {
        id: `apostila_${Date.now()}`,
        name: fullName, email, cpf: cleanedCpf,
        product: 'Apostila Digital - Módulo I'
    };
    
    const { error: insertError } = await supabase.from('vendas_apostila').insert([newSale]);

    if (insertError) {
        console.error("Erro ao inserir no Supabase:", insertError);
        return res.status(500).json({ error: "Falha ao registrar a venda." });
    }
    
    const paymentData = {
        transaction_amount: APOSTILA_PRICE,
        description: 'Apostila Digital - Módulo I: Luto Mal Resolvido',
        payment_method_id: 'pix',
        payer: { email: email, first_name: firstName, last_name: lastName, identification: { type: 'CPF', number: cleanedCpf }},
        notification_url: `${PUBLIC_URL}/webhook-mp-apostila`, 
        external_reference: newSale.id,
    };

    try {
        const response = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, {
            headers: { 'Authorization': `Bearer ${MERCADO_PAGO_TOKEN}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': newSale.id }
        });
        
        await supabase.from('vendas_apostila').update({ payment_id: response.data.id }).eq('id', newSale.id);

        const qrData = response.data.point_of_interaction.transaction_data;
        res.json({ saleId: newSale.id, qrCodeText: qrData.qr_code, qrCodeBase64: qrData.qr_code_base64 });
    } catch (error) {
        console.error("Erro ao criar pagamento no MP:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: "Não foi possível criar o pagamento." });
    }
});

app.get('/check-status', async (req, res) => {
    const { saleId } = req.query;
    const { data, error } = await supabase.from('vendas_apostila').select('status').eq('id', saleId).single();

    if (error || !data) return res.status(404).json({ error: 'Venda não encontrada.' });
    res.json({ status: data.status });
});

app.post('/webhook-mp-apostila', async (req, res) => {
    const notification = req.body;
    if (notification.type === 'payment' && MERCADO_PAGO_TOKEN) {
        try {
            const paymentDetails = await axios.get(`https://api.mercadopago.com/v1/payments/${notification.data.id}`, {
                headers: { 'Authorization': `Bearer ${MERCADO_PAGO_TOKEN}` }
            });
            const { status, external_reference } = paymentDetails.data;

            if (status === 'approved' && external_reference) {
                const { data: saleData } = await supabase.from('vendas_apostila').select('status').eq('id', external_reference).single();
                
                if (saleData && saleData.status !== 'paid') {
                    const { data: updatedSale, error } = await supabase
                        .from('vendas_apostila')
                        .update({ status: 'paid' })
                        .eq('id', external_reference)
                        .select()
                        .single();

                    if (updatedSale && !error) {
                        console.log(`✅ [Webhook] Venda ${external_reference} atualizada para 'pago' no Supabase!`);
                        if (EMAIL_CONFIG.user && EMAIL_CONFIG.pass) {
                            await sendApostilaEmail(updatedSale);
                        }
                    }
                }
            }
        } catch (error) { console.error("Erro no webhook:", error.message); }
    }
    res.sendStatus(200);
});

app.post('/save-whatsapp', async (req, res) => {
    const { saleId, whatsapp } = req.body;
    if (!saleId || !whatsapp) {
        return res.status(400).json({ error: 'Dados incompletos.' });
    }

    const { error } = await supabase.from('vendas_apostila').update({ whatsapp: whatsapp }).eq('id', saleId);

    if (error) {
        console.error("Erro ao salvar WhatsApp no Supabase:", error);
        return res.status(500).json({ success: false, message: "Não foi possível salvar o número." });
    }

    console.log(`📱 WhatsApp salvo para a venda ${saleId}`);
    res.json({ success: true, message: "Número salvo com sucesso!" });
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor da Apostila (com Supabase) rodando na porta ${PORT}`);
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.warn("\n⚠️  ATENÇÃO: Variáveis de ambiente do Supabase não encontradas. O servidor não funcionará corretamente.\n");
    }
     if (!fs.existsSync(APOSTILA_FILE_PATH)) {
        console.warn("\n⚠️  ATENÇÃO: O arquivo 'apostila.pdf' não foi encontrado. O envio de e-mail falhará.\n");
    }
});