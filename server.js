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
                    
                    // false = فتح الصندوق بوضع القراءة والكتابة لكي يعمل markSeen: true
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
                                
                                // 🔥 أخذ آخر 3 رسائل غير مقروءة فقط لتجنب تعليق السيرفر بالرسائل القديمة
                                const latestUnread = results.slice(-3);
                                
                                // markSeen: true يحول الرسالة في Gmail إلى "مقروءة" فوراً
                                const f = imap.fetch(latestUnread, { bodies: '', markSeen: true });
                                
                                f.on('message', function(msg, seqno) {
                                    msg.on('body', function(stream) {
                                        simpleParser(stream, (err, parsed) => {
                                            if (err || !parsed) return;
                                            
                                            const rawBody = (parsed.text || "") + " " + (parsed.html || "");
                                            
                                            // 1. تنظيف النص بالكامل من أكواد HTML
                                            let cleanText = rawBody.replace(/<[^>]+>/g, ' ');

                                            // 2. إزالة جميع المسافات والفراغات تماماً لكي تلتصق الأرقام المتباعدة ببعضها
                                            let textWithoutSpaces = cleanText.replace(/\s+/g, '');

                                            // 3. البحث الآن في النص المضغوط عن كلمة OTP متبوعة بـ 6 أرقام، أو مجرد 6 أرقام متتالية
                                            const blsMatch = textWithoutSpaces.match(/OTP.*?(\d{6})/i);
                                            const generalMatch = textWithoutSpaces.match(/(?<!\d)(\d{6})(?!\d)/);
                                            const otp = blsMatch ? blsMatch[1] : (generalMatch ? generalMatch[1] : null);

                                            if (otp) {
                                                console.log("🚀 تم قراءة الرسالة وإيجاد الكود:", otp);
                                                if (ws.readyState === WebSocket.OPEN) {
                                                    ws.send(otp);
                                                }
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
