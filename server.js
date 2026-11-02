const Imap = require('imap');
const { simpleParser } = require('mailparser');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`🚀 WebSocket server running on port ${PORT}`);

// إرسال نبضات (Ping) للحفاظ على اتصال Railway نشطاً ومنعه من النوم أثناء الانتظار
setInterval(() => {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.ping();
        }
    });
}, 25000);

wss.on('connection', function connection(ws) {
    console.log("✅ جهاز جديد متصل، في انتظار بيانات الإيميل...");
    let imap = null;
    let searchInterval = null;
    let isSearching = false;

    ws.on('message', function incoming(message) {
        try {
            const data = JSON.parse(message);
            
            if (data.action === 'start_imap' && data.email && data.password) {
                console.log(`🔄 محاولة الاتصال بالإيميل: ${data.email}`);

                if (imap) {
                    try { imap.end(); } catch (e) {}
                    clearInterval(searchInterval);
                }

                // إعدادات IMAP محسنة لعدم انقطاع الاتصال
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
                        forceNoop: true // إجبار Gmail على إبقاء الاتصال حياً
                    },
                    authTimeout: 10000
                });

                imap.once('ready', function() {
                    console.log("📬 تم الاتصال بصندوق الوارد بنجاح!");
                    if (ws.readyState === WebSocket.OPEN) ws.send("IMAP_READY");
                    
                    imap.openBox('INBOX', false, function(err, box) {
                        if (err) {
                            console.error("❌ خطأ في فتح الصندوق:", err);
                            if (ws.readyState === WebSocket.OPEN) ws.send("ERROR");
                            return;
                        }

                        function searchForOTP() {
                            if (isSearching || !imap || imap.state !== 'authenticated') return;
                            isSearching = true;

                            imap.search(['UNSEEN'], function(err, results) {
                                if (err || !results || results.length === 0) {
                                    isSearching = false;
                                    return;
                                }
                                
                                const latestUnread = results.slice(-1);
                                const f = imap.fetch(latestUnread, { bodies: '', markSeen: true });
                                
                                f.on('message', function(msg, seqno) {
                                    msg.on('body', function(stream) {
                                        simpleParser(stream, (err, parsed) => {
                                            if (err || !parsed) return;
                                            
                                            const sender = parsed.from && parsed.from.text ? parsed.from.text.toLowerCase() : "";
                                            const subject = parsed.subject ? parsed.subject.toLowerCase() : "";
                                            
                                            const isFromBLS = sender.includes('bls') || subject.includes('appointment') || subject.includes('verification') || subject.includes('consent');
                                            
                                            if (!isFromBLS) return;

                                            const htmlBody = parsed.html || "";
                                            const rawBody = (parsed.text || "") + " " + htmlBody;
                                            let cleanText = rawBody.replace(/<[^>]+>/g, ' ');
                                            let textWithoutSpaces = cleanText.replace(/\s+/g, '');

                                            const blsMatch = textWithoutSpaces.match(/OTP.*?(\d{6})/i);
                                            const otp = blsMatch ? blsMatch[1] : null;

                                            const consentMatch = htmlBody.match(/<a[^>]+href="([^"]+)"[^>]*>\s*Accept\s*<\/a>/i);
                                            let consentLink = consentMatch ? consentMatch[1] : null;

                                            if (otp) {
                                                console.log("🎯 [نجاح] تم جلب OTP:", otp);
                                                if (ws.readyState === WebSocket.OPEN) ws.send(otp);
                                            } else if (consentLink) {
                                                consentLink = consentLink.replace(/&amp;/g, '&');
                                                console.log("🔗 [نجاح] تم جلب رابط الموافقة (Consent):", consentLink);
                                                if (ws.readyState === WebSocket.OPEN) ws.send(consentLink);
                                            }
                                        });
                                    });
                                });

                                f.once('error', (err) => { isSearching = false; });
                                f.once('end', () => { isSearching = false; });
                            });
                        }

                        // البحث الفوري عند الاتصال
                        searchForOTP();
                        
                        // الاستماع الفوري واللحظي للرسائل دون الحاجة لضرب السيرفر باستمرار
                        imap.on('mail', searchForOTP);
                        imap.on('update', searchForOTP);

                        // فحص احتياطي هادئ كل 5 ثواني (بدل 2 ثانية) لتجنب حظر جوجل
                        searchInterval = setInterval(searchForOTP, 5000);
                    });
                });

                imap.once('error', function(err) {
                    console.error("❌ خطأ IMAP:", err.message);
                    if (ws.readyState === WebSocket.OPEN) ws.send("ERROR");
                    clearInterval(searchInterval);
                    isSearching = false;
                });

                imap.once('end', function() {
                    console.log("⚠️ انقطع اتصال IMAP.");
                    clearInterval(searchInterval);
                    isSearching = false;
                });

                imap.connect();
            }
        } catch (e) {
            console.error("❌ خطأ في معالجة الرسالة:", e.message);
        }
    });

    ws.on('close', () => {
        console.log("🔴 تم قطع اتصال العميل (المتصفح).");
        if (imap) { try { imap.end(); } catch (e) {} }
        if (searchInterval) clearInterval(searchInterval);
    });
});
