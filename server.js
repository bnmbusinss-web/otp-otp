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
                    keepalive: true
                });

                imap.once('ready', function() {
                    console.log("📬 تم الاتصال بصندوق الوارد بنجاح!");
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send("IMAP_READY");
                    }
                    
                    imap.openBox('INBOX', false, function(err, box) {
                        if (err) {
                            console.error("❌ خطأ في فتح الصندوق:", err);
                            return;
                        }

                        function searchForOTP() {
                            if (isSearching || !imap || imap.state !== 'authenticated') return;
                            isSearching = true;

                            // البحث عن الرسائل غير المقروءة فقط
                            imap.search(['UNSEEN'], function(err, results) {
                                if (err || !results || results.length === 0) {
                                    isSearching = false;
                                    return;
                                }
                                
                                // 🔥 فلتر 1: جلب "أحدث" رسالة واحدة فقط بدلاً من جلب رسائل قديمة
                                const latestUnread = results.slice(-1);
                                
                                const f = imap.fetch(latestUnread, { bodies: '', markSeen: true });
                                
                                f.on('message', function(msg, seqno) {
                                    msg.on('body', function(stream) {
                                        simpleParser(stream, (err, parsed) => {
                                            if (err || !parsed) return;
                                            
                                            // 🔥 فلتر 2: التأكد من أن الرسالة من BLS وتخص المواعيد
                                            const sender = parsed.from && parsed.from.text ? parsed.from.text.toLowerCase() : "";
                                            const subject = parsed.subject ? parsed.subject.toLowerCase() : "";
                                            
                                            const isFromBLS = sender.includes('bls') || subject.includes('appointment') || subject.includes('verification');
                                            
                                            if (!isFromBLS) {
                                                console.log("⚠️ تم تجاهل رسالة لأنها ليست من شركة BLS.");
                                                return;
                                            }

                                            const rawBody = (parsed.text || "") + " " + (parsed.html || "");
                                            let cleanText = rawBody.replace(/<[^>]+>/g, ' ');
                                            let textWithoutSpaces = cleanText.replace(/\s+/g, '');

                                            // 🔥 فلتر 3: استخراج كود الـ OTP المكون من 6 أرقام بدقة بالغة
                                            const blsMatch = textWithoutSpaces.match(/OTP.*?(\d{6})/i);
                                            const otp = blsMatch ? blsMatch[1] : null;

                                            if (otp) {
                                                console.log("🎯 [نجاح] تم جلب OTP صحيح وجديد:", otp);
                                                if (ws.readyState === WebSocket.OPEN) {
                                                    ws.send(otp);
                                                }
                                            } else {
                                                console.log("⚠️ الرسالة من BLS لكن لم يتم العثور على الكود بداخلها.");
                                            }
                                        });
                                    });
                                });

                                f.once('error', function(err) {
                                    console.log("⚠️ خطأ في الجلب:", err.message);
                                    isSearching = false;
                                });

                                f.once('end', function() {
                                    isSearching = false;
                                });
                            });
                        }

                        searchForOTP();
                        searchInterval = setInterval(searchForOTP, 2000);
                        
                        imap.on('mail', function() {
                            console.log("📩 وصلت رسالة جديدة!");
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
            console.error("❌ بيانات غير صالحة مرسلة من المتصفح.");
        }
    });

    ws.on('close', () => {
        if (imap) {
            try { imap.end(); } catch (e) {}
        }
        if (searchInterval) clearInterval(searchInterval);
        console.log("تم قطع الاتصال.");
    });
});
