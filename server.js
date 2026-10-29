const Imap = require('imap');
const { simpleParser } = require('mailparser');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`WebSocket server running on port ${PORT}`);

wss.on('connection', function connection(ws) {
    console.log("✅ جهاز جديد متصل، في انتظار بيانات الإيميل...");
    let imap = null;
    let searchInterval = null;
    let isSearching = false;
    let lastSentOtp = null;

    ws.on('message', function incoming(message) {
        try {
            const data = JSON.parse(message);
            
            if (data.action === 'start_imap' && data.email && data.password) {
                console.log(`محاولة الاتصال بالإيميل: ${data.email}`);

                if (imap) {
                    try { imap.end(); } catch (e) {}
                    clearInterval(searchInterval);
                }

                imap = new Imap({
                    user: data.email.trim(),
                    password: data.password.replace(/\s+/g, ''),
                    host: 'imap.gmail.com',
                    port: 993,
                    tls: true,
                    tlsOptions: { rejectUnauthorized: false },
                    keepalive: {
                        interval: 10000,
                        idleInterval: 300000,
                        forceNoop: true
                    }
                });

                imap.once('ready', function() {
                    console.log("📬 تم الاتصال بصندوق الوارد بنجاح! جاري مراقبة أكواد BLS...");
                    
                    imap.openBox('INBOX', false, function(err, box) {
                        if (err) {
                            console.error("❌ خطأ في فتح الصندوق:", err);
                            return;
                        }

                        function searchForOTP() {
                            if (isSearching || !imap || imap.state !== 'authenticated') return;
                            isSearching = true;

                            // البحث في رسائل آخر 24 ساعة (سواء مقروءة أو غير مقروءة لتفادي مشكلة فتح الرسالة)
                            const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
                            
                            imap.search([['SINCE', yesterday]], function(err, results) {
                                if (err || !results || results.length === 0) {
                                    isSearching = false;
                                    return;
                                }
                                
                                // جلب آخر 3 رسائل وصلت فقط لضمان السرعة الفائقة وعدم تعليق السيرفر
                                const latestUids = results.slice(-3);
                                const f = imap.fetch(latestUids, { bodies: '', markSeen: false });
                                
                                let messages = [];

                                f.on('message', function(msg, seqno) {
                                    msg.on('body', function(stream) {
                                        simpleParser(stream, (err, parsed) => {
                                            if (!err && parsed) {
                                                messages.push(parsed);
                                            }
                                        });
                                    });
                                });

                                f.once('error', function(err) {
                                    console.error("⚠️ خطأ أثناء جلب الرسالة:", err);
                                    isSearching = false;
                                });

                                f.once('end', function() {
                                    // انتظار بسيط لضمان انتهاء simpleParser من تحليل النص
                                    setTimeout(() => {
                                        // ترتيب الرسائل من الأحدث إلى الأقدم
                                        messages.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

                                        for (const parsed of messages) {
                                            // التأكد أن الرسالة حديثة (وصلت خلال آخر 10 دقائق كحد أقصى)
                                            const emailTime = new Date(parsed.date || Date.now()).getTime();
                                            if (Date.now() - emailTime > 10 * 60 * 1000) continue;

                                            const rawBody = parsed.html || parsed.text || "";
                                            // إزالة وسوم الـ HTML لاستخراج النص الصافي فقط
                                            const cleanText = rawBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

                                            // 1. البحث عن صيغة BLS المباشرة (OTP: 003611) أولاً ثم أي كود من 6 أرقام
                                            const blsMatch = cleanText.match(/OTP\s*[:\-]?\s*(\d{6})/i);
                                            const generalMatch = cleanText.match(/\b(\d{6})\b/);
                                            const otp = blsMatch ? blsMatch[1] : (generalMatch ? generalMatch[1] : null);

                                            if (otp) {
                                                if (otp !== lastSentOtp) {
                                                    lastSentOtp = otp;
                                                    console.log("🚀 تم إيجاد كود جديد وإرساله للمتصفح:", otp);
                                                    if (ws.readyState === WebSocket.OPEN) {
                                                        ws.send(otp);
                                                    }
                                                }
                                                break; // التوقف بعد إيجاد أحدث كود
                                            }
                                        }
                                        isSearching = false;
                                    }, 300);
                                });
                            });
                        }

                        // فحص فوري عند الاتصال، ثم كل ثانيتين، وعند وصول أي بريد جديد
                        searchForOTP();
                        searchInterval = setInterval(searchForOTP, 2000);
                        
                        imap.on('mail', function() {
                            console.log("📩 إشعار ببريد جديد في الصندوق!");
                            searchForOTP();
                        });
                    });
                });

                imap.once('error', function(err) {
                    console.log("❌ خطأ IMAP: ", err.message);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send("ERROR");
                    }
                    clearInterval(searchInterval);
                    isSearching = false;
                });

                imap.connect();
            }
        } catch (e) {
            console.error("❌ بيانات غير صالحة مرسلة من المتصفح:", e);
        }
    });

    ws.on('close', () => {
        if (imap) {
            try { imap.end(); } catch (e) {}
        }
        if (searchInterval) clearInterval(searchInterval);
        console.log("🔌 تم قطع الاتصال.");
    });
});
