require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// --- INICIALIZAÇÃO DO APP ---
const app = express();

// --- CONSTANTES E CONFIGURAÇÕES ---
const APOSTILA_FILE_PATH = path.join(__dirname, 'apostila.pdf');
const APOSTILA_PRICE = 19.90;

// Carrega as variáveis de ambiente
const MERCADO_PAGO_TOKEN = process.env.MERCADO_PAGO_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const EMAIL_CONFIG = {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
};
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Inicializa os clientes dos serviços
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: EMAIL_CONFIG.user, pass: EMAIL_CONFIG.pass },
});

// --- MIDDLEWARE (Executado em todos os pedidos, na ordem) ---

// 1. Middleware Essencial: Habilita CORS e o parser de JSON
app.use(cors());
app.use(express.json());

// 2. Servir Ficheiros Estáticos: Procura por imagens, etc., na pasta raiz
app.use(express.static(path.join(__dirname, '')));


// --- FUNÇÃO DE ENVIO DE E-MAIL ---
async function sendApostilaEmail(sale) {
    if (!fs.existsSync(APOSTILA_FILE_PATH)) {
        console.error("ERRO CRÍTICO: Ficheiro da apostila (apostila.pdf) não encontrado no servidor.");
        return;
    }
    try {
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


// --- ROTAS DA API (Handlers específicos para a funcionalidade do site) ---

app.post('/create-payment-apostila', async (req, res) => {
    if (!MERCADO_PAGO_TOKEN || !PUBLIC_URL) {
        return res.status(500).json({ error: "O servidor não está configurado corretamente." });
    }
    const { fullName, email, cpf } = req.body;
    const nameParts = fullName.trim().split(' ');
    const firstName = nameParts.shift();
    const lastName = nameParts.join(' ');
    const cleanedCpf = cpf.replace(/[^\d]/g, "");

    const newSale = {
        id: `apostila_${Date.now()}`,
        name: fullName,
        email: email,
        cpf: cleanedCpf,
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
        payer: { email, first_name: firstName, last_name: lastName, identification: { type: 'CPF', number: cleanedCpf } },
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
                    const { data: updatedSale, error } = await supabase.from('vendas_apostila').update({ status: 'paid' }).eq('id', external_reference).select().single();
                    if (updatedSale && !error) {
                        console.log(`✅ [Webhook] Venda ${external_reference} atualizada para 'pago'!`);
                        await sendApostilaEmail(updatedSale);
                    }
                }
            }
        } catch (error) { console.error("Erro no webhook:", error.message); }
    }
    res.sendStatus(200);
});

app.post('/save-whatsapp', async (req, res) => {
    const { saleId, whatsapp } = req.body;
    if (!saleId || !whatsapp) return res.status(400).json({ error: 'Dados incompletos.' });
    const { error } = await supabase.from('vendas_apostila').update({ whatsapp: whatsapp }).eq('id', saleId);
    if (error) {
        console.error("Erro ao salvar WhatsApp:", error);
        return res.status(500).json({ success: false, message: "Não foi possível salvar o número." });
    }
    console.log(`📱 WhatsApp salvo para a venda ${saleId}`);
    res.json({ success: true, message: "Número salvo com sucesso!" });
});


// --- ROTA PRINCIPAL DO HTML (deve ser a última) ---
// Se um pedido não corresponder a um ficheiro estático ou a uma rota da API, ele cairá aqui.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'apostila.html'));
});


// --- INICIAR O SERVIDOR ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});