// netlify/functions/process-payment.js
const axios = require('axios');
const { Formidable } = require('formidable');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const { Readable } = require('stream');
const fs = require('fs');
const FormData = require('form-data');

// Función de Normalización
function normalizeWhatsappNumber(number) {
    if (!number) return null;

    // 1. Eliminar todos los caracteres no numéricos
    let cleanedNumber = number.replace(/[^\d]/g, '');

    // 2. Manejar prefijos comunes de Venezuela
    // La forma estándar es 58412... o 58424...
    
    // Si empieza con '0412', '0414', '0416', '0424', '0426', etc. (Formato local con 0)
    // Se asume que el código de país (58) está implícito si el número tiene 11 dígitos.
    if (cleanedNumber.length === 11 && cleanedNumber.startsWith('0')) {
        // Quita el 0 y añade el 58. Ej: 04121234567 -> 584121234567
        return '58' + cleanedNumber.substring(1);
    }

    // Si empieza con '580412', '580414', etc. (Formato +58 con el 0 del código de área)
    if (cleanedNumber.length === 13 && cleanedNumber.startsWith('580')) {
        // Quita el 0 después del 58. Ej: 5804121234567 -> 584121234567
        return '58' + cleanedNumber.substring(3);
    }
    
    // Si ya empieza con '58' y tiene 12 dígitos, ya está correcto. Ej: 584121234567
    if (cleanedNumber.length === 12 && cleanedNumber.startsWith('58')) {
        return cleanedNumber;
    }
    
    // Si empieza con el código de área sin el 58. (Poco probable, pero de seguridad)
    if (cleanedNumber.length === 10 && (cleanedNumber.startsWith('412') || cleanedNumber.startsWith('424') || cleanedNumber.startsWith('414') || cleanedNumber.startsWith('416') || cleanedNumber.startsWith('426'))) {
        return '58' + cleanedNumber;
    }

    // Si el número no encaja en los patrones de Venezuela, devolvemos el número limpio 
    // por defecto, aunque para el link de WhatsApp debe ser el formato E.164 sin el +.
    // Para simplificar, si no se pudo normalizar al formato 58..., devolvemos null o el original limpio.
    if (cleanedNumber.length >= 10) {
        // Si no cumple el formato 58... pero está limpio, lo devolvemos
        return cleanedNumber; 
    }

    return null; // Devuelve null si no es un número de teléfono válido/esperado
}


exports.handler = async function(event, context) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    let data;
    let paymentReceiptFile; 

    // --- Configuración de Supabase ---
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // --- Parsing de FormData con formidable ---
    const form = new Formidable({ multiples: true });

    let bodyBuffer;
    if (event.isBase64Encoded) {
        bodyBuffer = Buffer.from(event.body, 'base64');
    } else {
        bodyBuffer = Buffer.from(event.body || '');
    }

    const reqStream = new Readable();
    reqStream.push(bodyBuffer);
    reqStream.push(null);

    reqStream.headers = event.headers;
    reqStream.method = event.httpMethod;

    try {
        if (event.headers['content-type'] && event.headers['content-type'].includes('multipart/form-data')) {
            const { fields, files } = await new Promise((resolve, reject) => {
                form.parse(reqStream, (err, fields, files) => {
                    if (err) {
                        console.error('Formidable parse error:', err);
                        return reject(err); 
                    }
                    resolve({ fields, files });
                });
            });

            // Procesar campos, tratando arrays de un solo elemento como strings
            data = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
            
            // Aquí se toma el archivo de comprobante del campo 'paymentReceipt'
            paymentReceiptFile = files['paymentReceipt'] ? files['paymentReceipt'][0] : null;

        } else if (event.headers['content-type'] && event.headers['content-type'].includes('application/json')) {
            data = JSON.parse(event.body);
        } else {
            const { parse } = require('querystring');
            data = parse(event.body);
        }
    } catch (parseError) {
        console.error("Error al procesar los datos de la solicitud:", parseError);
        return {
            statusCode: 400,
            body: JSON.stringify({ message: `Error al procesar los datos de la solicitud: ${parseError.message || 'Unknown error'}. Por favor, verifica tus datos e inténtalo de nuevo.` })
        };
    }

    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    const SMTP_HOST = process.env.SMTP_HOST;
    const SMTP_PORT = process.env.SMTP_PORT;
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const SENDER_EMAIL = process.env.SENDER_EMAIL || SMTP_USER;

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !SMTP_HOST || !parseInt(SMTP_PORT, 10) || !SMTP_USER || !SMTP_PASS || !supabaseUrl || !supabaseServiceKey) {
        console.error("Faltan variables de entorno requeridas o SMTP_PORT no es un número válido.");
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Error de configuración del servidor: Faltan credenciales o configuración inválida." })
        };
    }

    // --- Extracción y Normalización de Datos del Carrito y Globales ---
    const { finalPrice, currency, paymentMethod, email, whatsappNumber, cartDetails, totalJPUSD } = data;
    
    // Normalizar el número de WhatsApp aquí
    const normalizedWhatsapp = normalizeWhatsappNumber(whatsappNumber);
    if (normalizedWhatsapp) {
        data.whatsappNumber = normalizedWhatsapp;
    }
    
    // Parsear el JSON del carrito
    let cartItems = [];
    if (cartDetails) {
        try {
            cartItems = JSON.parse(cartDetails);
        } catch (e) {
            console.error("Error al parsear cartDetails JSON:", e);
            return {
                statusCode: 400,
                body: JSON.stringify({ message: "Formato de detalles del carrito inválido." })
            };
        }
    }

    if (cartItems.length === 0) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: "El carrito de compra está vacío." })
        };
    }
    
    // Obtener detalles específicos del método de pago
    let methodSpecificDetails = {};
    if (paymentMethod === 'pago-movil') {
        methodSpecificDetails.phone = data.phone;
        methodSpecificDetails.reference = data.reference;
    } else if (paymentMethod === 'binance') {
        methodSpecificDetails.txid = data.txid;
    } else if (paymentMethod === 'zinli') {
        methodSpecificDetails.reference = data.reference;
    } else if (paymentMethod === 'nequi') {
        methodSpecificDetails.reference = data.reference || 'Nequi Transfer';
    } else if (paymentMethod === 'zelle') {
        methodSpecificDetails.reference = 'Zelle Payment - Contact WhatsApp';
    } else if (paymentMethod === 'wallet') {
        methodSpecificDetails.reference = 'Wallet Deduction - Automatic';
    }
    
    // --- Guardar Transacción Inicial en Supabase ---
    let newTransactionData;
    let id_transaccion_generado;

    try {
        // 🎯 CAMBIO: Prefijo actualizado a JP-
        id_transaccion_generado = `JP-${Date.now()}`;

        const firstItem = cartItems[0] || {};
        
        const transactionToInsert = {
            id_transaccion: id_transaccion_generado,
            finalPrice: parseFloat(finalPrice),
            currency: currency,
            paymentMethod: paymentMethod,
            email: email,
            whatsappNumber: normalizedWhatsapp || whatsappNumber || null,
            methodDetails: methodSpecificDetails,
            status: 'pendiente',
            telegram_chat_id: TELEGRAM_CHAT_ID,
            // 🎯 NUEVO: Guardar totalJPUSD si está disponible
            total_jpusd: totalJPUSD ? parseFloat(totalJPUSD) : null,
            receipt_url: paymentReceiptFile ? paymentReceiptFile.filepath : null,
            
            // Campo para el Google ID de la billetera
            google_id: firstItem.google_id || null, 
            
            // Campos de compatibilidad
            game: firstItem.game || 'Carrito Múltiple',
            packageName: firstItem.packageName || 'Múltiples Paquetes',
            playerId: firstItem.playerId || null,
            roblox_email: firstItem.robloxEmail || null,
            roblox_password: firstItem.robloxPassword || null,
            codm_email: firstItem.codmEmail || null,
            codm_password: firstItem.codmPassword || null,
            codm_vinculation: firstItem.codmVinculation || null
        };

        const { data: insertedData, error: insertError } = await supabase
            .from('transactions')
            .insert(transactionToInsert)
            .select();

        if (insertError) {
            throw insertError; 
        }
        newTransactionData = insertedData[0];
        console.log("Transacción guardada en Supabase con ID interno:", newTransactionData.id);

    } catch (supabaseError) {
        console.error("Error al guardar la transacción en Supabase:", supabaseError.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Error al guardar la transacción en la base de datos." })
        };
    }

    // --- Generar Notificación para Telegram ---
    
    const firstItem = cartItems[0] || {};
    const isWalletRecharge = cartItems.length === 1 && firstItem.game === 'Recarga de Saldo';
    
    console.log("[DEBUG - GLOBAL] currency:", currency);
    console.log("[DEBUG - GLOBAL] finalPrice:", finalPrice);
    console.log("[DEBUG - GLOBAL] totalJPUSD:", totalJPUSD);

    // 🎯 CAMBIO: Nombre actualizado a JP STORE
    let messageText = isWalletRecharge 
        ? `💸 Nueva Recarga de Billetera JP STORE 💸\n\n`
        : `✨ Nueva Recarga (CARRITO) JP STORE ✨\n\n`;
    
    messageText += `*ID de Transacción:* \`${id_transaccion_generado || 'N/A'}\`\n`;
    messageText += `*Estado:* \`PENDIENTE\`\n`;
    
    if (isWalletRecharge && firstItem.google_id) {
        messageText += `🔗 *Google ID (Billetera):* \`${firstItem.google_id}\`\n`;
        messageText += `💵 *Monto Recargado (Paquete):* *${firstItem.packageName || 'N/A'}*\n`;
    }
    
    messageText += `------------------------------------------------\n`;

    // Iterar sobre los productos del carrito para el detalle
    cartItems.forEach((item, index) => {
        messageText += `*📦 Producto ${index + 1}:*\n`;
        messageText += `🎮 Juego/Servicio: *${item.game || 'N/A'}*\n`;
        messageText += `📦 Paquete: *${item.packageName || 'N/A'}*\n`;
        
        // Lógica de impresión de credenciales y IDs
        if (item.game === 'Roblox') {
            messageText += `📧 Correo Roblox: ${item.robloxEmail || 'N/A'}\n`;
            messageText += `🔑 Contraseña Roblox: ${item.robloxPassword || 'N/A'}\n`;
        } else if (item.game === 'Call of Duty Mobile') {
            messageText += `📧 Correo CODM: ${item.codmEmail || 'N/A'}\n`;
            messageText += `🔑 Contraseña CODM: ${item.codmPassword || 'N/A'}\n`;
            messageText += `🔗 Vinculación CODM: ${item.codmVinculation || 'N/A'}\n`;
        } else if (item.playerId) {
            messageText += `👤 ID de Jugador: *${item.playerId}*\n`;
        }
        
        // 🎯 LÓGICA ACTUALIZADA DE PRECIOS PARA SOPORTAR JPUSD
        console.log(`\n[DEBUG - ITEM ${index + 1}] --- PRECIOS EN CARRO ---`);
        console.log(`[DEBUG] item.currency (Inicial): ${item.currency}`);
        console.log(`[DEBUG] item.priceUSD: ${item.priceUSD}`);
        console.log(`[DEBUG] item.priceJPUSD: ${item.priceJPUSD}`);
        console.log(`[DEBUG] item.priceVES: ${item.priceVES}`);
        console.log(`[DEBUG] item.priceCOP: ${item.priceCOP}`);
        
        let itemPrice;
        let itemCurrency = currency; // Usa la moneda global
        
        console.log(`[DEBUG] itemCurrency (Seleccionada - Global): ${itemCurrency}`);

        if (itemCurrency === 'JPUSD') { 
            // 🎯 NUEVA LÓGICA: JPUSD usa priceJPUSD
            itemPrice = item.priceJPUSD || item.priceUSD;
            console.log(`[DEBUG] LÓGICA APLICADA: GLOBAL JPUSD. Price usado: ${itemPrice}. Fuente: item.priceJPUSD`);
        } else if (itemCurrency === 'VES') {
            // Lógica VES
            itemPrice = item.priceVES;
            console.log(`[DEBUG] LÓGICA APLICADA: GLOBAL VES. Price usado: ${itemPrice}. Fuente: item.priceVES`);
        } else if (itemCurrency === 'COP') {
            // 🎯 NUEVA LÓGICA: COP
            itemPrice = item.priceCOP || item.priceUSD;
            console.log(`[DEBUG] LÓGICA APLICADA: GLOBAL COP. Price usado: ${itemPrice}. Fuente: item.priceCOP`);
        } else {
            // Lógica USD (o fallback si la moneda global no es JPUSD, VES ni COP)
            itemPrice = item.priceUSD;
            console.log(`[DEBUG] LÓGICA APLICADA: GLOBAL USD/Fallback. Price usado: ${itemPrice}. Fuente: item.priceUSD`);
        }
        
        console.log(`[DEBUG - ITEM ${index + 1}] Final itemPrice (Raw): ${itemPrice}`);
        
        if (itemPrice) {
            messageText += `💲 Precio (Est.): ${parseFloat(itemPrice).toFixed(2)} ${itemCurrency}\n`;
        }
        
        messageText += `------------------------------------------------\n`;
    });

    // Información de Pago y Contacto (Global)
    messageText += `\n*RESUMEN DE PAGO*\n`;
    messageText += `💰 *TOTAL A PAGAR:* *${finalPrice} ${currency}*\n`;
    
    // 🎯 AÑADIR: Mostrar totalJPUSD si existe
    if (totalJPUSD && currency !== 'JPUSD') {
        messageText += `💳 *Total JPUSD (Base):* *${parseFloat(totalJPUSD).toFixed(2)} JPUSD*\n`;
    }
    
    messageText += `💳 Método de Pago: *${paymentMethod.replace('-', ' ').toUpperCase()}*\n`;
    messageText += `📧 Correo Cliente: ${email}\n`;
    
    // Mostrar el número original y el normalizado para referencia en el chat
    if (whatsappNumber) {
        messageText += `📱 WhatsApp Cliente: ${whatsappNumber}\n`;
        if (normalizedWhatsapp && normalizedWhatsapp !== whatsappNumber) {
             messageText += `(Número normalizado: ${normalizedWhatsapp})\n`;
        }
    }

    // Detalles específicos del método de pago
    if (paymentMethod === 'pago-movil') {
        messageText += `📞 Teléfono Pago Móvil: ${methodSpecificDetails.phone || 'N/A'}\n`;
        messageText += `📊 Referencia Pago Móvil: ${methodSpecificDetails.reference || 'N/A'}\n`;
    } else if (paymentMethod === 'binance') {
        messageText += `🆔 TXID Binance: ${methodSpecificDetails.txid || 'N/A'}\n`;
    } else if (paymentMethod === 'nequi') {
        messageText += `📊 Referencia Nequi: ${methodSpecificDetails.reference || 'N/A'}\n`;
    } else if (paymentMethod === 'zelle') {
        messageText += `💳 Método Zelle: Contactar WhatsApp para datos\n`;
    } else if (paymentMethod === 'wallet') {
        messageText += `👛 Método Wallet: Deducción automática de saldo\n`;
    }

    // Construcción de Botones Inline para Telegram
    const inlineKeyboard = [
        [{ text: "✅ Marcar como Realizada", callback_data: `mark_done_${id_transaccion_generado}` }]
    ];
    
    if (normalizedWhatsapp) {
        // Crear el enlace de WhatsApp usando el número normalizado
        const whatsappLink = `https://wa.me/${normalizedWhatsapp}`;
        inlineKeyboard.push(
            [{ text: "💬 Contactar Cliente por WhatsApp", url: whatsappLink }]
        );
    }
    
    const replyMarkup = {
        inline_keyboard: inlineKeyboard
    };

    const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    let telegramMessageResponse;

    try {
        telegramMessageResponse = await axios.post(telegramApiUrl, {
            chat_id: TELEGRAM_CHAT_ID,
            text: messageText,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
        });
        console.log("Mensaje de Telegram enviado con éxito.");
        
        // 🚨 Enviar comprobante de pago a Telegram (sendDocument)
        if (paymentReceiptFile && paymentReceiptFile.filepath) {
            console.log("Comprobante de pago detectado. Preparando envío a Telegram...");
            
            // Asegúrate de que el archivo exista antes de intentar leerlo
            if (fs.existsSync(paymentReceiptFile.filepath)) {
                const fileStream = fs.createReadStream(paymentReceiptFile.filepath);
                const captionText = `*Comprobante de Pago* para Transacción \`${id_transaccion_generado}\`\n\n*Método:* ${paymentMethod.replace('-', ' ').toUpperCase()}\n*Monto:* ${finalPrice} ${currency}`;

                const form = new FormData();
                form.append('chat_id', TELEGRAM_CHAT_ID);
                form.append('caption', captionText);
                form.append('parse_mode', 'Markdown');
                form.append('document', fileStream, paymentReceiptFile.originalFilename || 'comprobante_pago.jpg');

                const telegramDocumentApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;

                const documentResponse = await axios.post(telegramDocumentApiUrl, form, {
                    headers: form.getHeaders(),
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                });
                console.log("Comprobante enviado a Telegram con éxito.");
            } else {
                console.warn("ADVERTENCIA: Archivo de comprobante temporal no encontrado en la ruta:", paymentReceiptFile.filepath);
            }
        }
        
        // --- Actualizar Transaction en Supabase con el Message ID de Telegram ---
        if (newTransactionData && telegramMessageResponse && telegramMessageResponse.data && telegramMessageResponse.data.result) {
            const { data: updatedData, error: updateError } = await supabase
                .from('transactions')
                .update({ telegram_message_id: telegramMessageResponse.data.result.message_id })
                .eq('id', newTransactionData.id);

            if (updateError) {
                console.error("Error al actualizar la transacción en Supabase con telegram_message_id:", updateError.message);
            } else {
                console.log("Transaction actualizada en Supabase con telegram_message_id:", telegramMessageResponse.data.result.message_id);
            }
        }

    } catch (telegramError) {
        console.error("Error al enviar mensaje de Telegram o comprobante:", telegramError.response ? telegramError.response.data : telegramError.message);
    }

    // --- Enviar Confirmación por Correo Electrónico al Cliente ---
    if (email) {
        let transporter;
        try {
            transporter = nodemailer.createTransport({
                host: SMTP_HOST,
                port: parseInt(SMTP_PORT, 10),
                secure: parseInt(SMTP_PORT, 10) === 465,
                auth: {
                    user: SMTP_USER,
                    pass: SMTP_PASS,
                },
                tls: {
                    rejectUnauthorized: false
                }
            });
        } catch (createTransportError) {
            console.error("Error al crear el transportador de Nodemailer:", createTransportError);
        }

        // Generar el HTML de los detalles del carrito para el correo
        let cartDetailsHtml = '';
        cartItems.forEach((item, index) => {
            let playerInfoEmail = '';
            let game = item.game || 'Servicio';
            let packageName = item.packageName || 'Paquete Desconocido';
            
            if (game === 'Roblox') {
                playerInfoEmail = `
                    <li><strong>Correo de Roblox:</strong> ${item.robloxEmail || 'N/A'}</li>
                    <li><strong>Contraseña de Roblox:</strong> ${item.robloxPassword || 'N/A'}</li>
                `;
            } else if (game === 'Call of Duty Mobile') {
                playerInfoEmail = `
                    <li><strong>Correo de CODM:</strong> ${item.codmEmail || 'N/A'}</li>
                    <li><strong>Contraseña de CODM:</strong> ${item.codmPassword || 'N/A'}</li>
                    <li><strong>Vinculación de CODM:</strong> ${item.codmVinculation || 'N/A'}</li>
                `;
            } else if (game === 'Recarga de Saldo' && item.google_id) { 
                playerInfoEmail = `
                    <li><strong>ID de Google (Billetera):</strong> ${item.google_id}</li>
                    <li><strong>Monto de Recarga (Paquete):</strong> ${packageName}</li>
                `;
            } else {
                playerInfoEmail = item.playerId ? `<li><strong>ID de Jugador:</strong> ${item.playerId}</li>` : '';
            }

            cartDetailsHtml += `
                <div style="border: 1px solid #ddd; padding: 10px; margin-bottom: 10px; border-radius: 5px;">
                    <p style="margin-top: 0;"><strong>Producto ${index + 1}: ${game}</strong></p>
                    <ul style="list-style: none; padding: 0; margin: 0;">
                        <li><strong>Paquete:</strong> ${packageName}</li>
                        ${playerInfoEmail}
                    </ul>
                </div>
            `;
        });
        
        // 🎯 CAMBIO: Nombre actualizado a JP STORE en el correo
        const mailOptions = {
            from: SENDER_EMAIL,
            to: email,
            subject: `🎉 Tu Solicitud de Recarga (Pedido #${id_transaccion_generado}) con JP STORE ha sido Recibida! 🎉`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2 style="color: #007bff;">¡Hola!</h2>
                    <p>Hemos recibido tu solicitud de recarga (Pedido #${id_transaccion_generado}).</p>
                    
                    <h3 style="color: #007bff;">Detalles del Pedido:</h3>
                    ${cartDetailsHtml}
                    
                    <p><strong>Monto Total a Pagar:</strong> <span style="font-size: 1.1em; color: #d9534f; font-weight: bold;">${finalPrice} ${currency}</span></p>
                    <p><strong>Método de Pago Seleccionado:</strong> ${paymentMethod.replace('-', ' ').toUpperCase()}</p>
                    ${whatsappNumber ? `<p><strong>Número de WhatsApp Proporcionado:</strong> ${whatsappNumber}</p>` : ''}
                    
                    <p>Tu solicitud está actualmente en estado: <strong>PENDIENTE</strong>.</p>
                    <p>Estamos procesando tu recarga. Te enviaremos un <strong>correo de confirmación de la recarga completada y tu factura virtual una vez que tu recarga sea procesada</strong> por nuestro equipo.</p>
                    <p style="margin-top: 20px;">¡Gracias por confiar en JP STORE!</p>
                    <p style="font-size: 0.9em; color: #777;">Si tienes alguna pregunta, contáctanos a través de nuestro WhatsApp: <a href="https://wa.me/584126949631" style="color: #28a745; text-decoration: none;">+58 412 6949631</a></p>
                </div>
            `,
        };

        try {
            if (transporter) {
                await transporter.sendMail(mailOptions);
                console.log("Correo de confirmación inicial enviado al cliente:", email);
            } else {
                 console.error("Transporter no inicializado, omitiendo envío de correo.");
            }
        } catch (emailError) {
            console.error("Error al enviar el correo de confirmación inicial:", emailError.message);
            if (emailError.response) {
                console.error("Detalles del error SMTP:", emailError.response);
            }
        }
    }

    // --- Limpieza del archivo temporal después de todo procesamiento ---
    if (paymentReceiptFile && paymentReceiptFile.filepath && fs.existsSync(paymentReceiptFile.filepath)) {
        try {
            fs.unlinkSync(paymentReceiptFile.filepath);
            console.log("Archivo temporal del comprobante eliminado al finalizar la función.");
        } catch (unlinkError) {
            console.error("Error al eliminar el archivo temporal del comprobante:", unlinkError);
        }
    }

    return {
        statusCode: 200,
        body: JSON.stringify({ message: "Solicitud de pago recibida exitosamente. ¡Te enviaremos una confirmación pronto!" }),
    };
};