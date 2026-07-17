'use client';

import { useEffect, useState } from 'react';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export default function MaintenancePage() {
  const [timeLeft, setTimeLeft] = useState<{ h: number; m: number; s: number } | null>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    let endTime = 0;
    let id: ReturnType<typeof setInterval>;
    let mounted = true;

    (async () => {
      try {
        const res = await fetch('/api/maintenance-status');
        const { countdownMinutes } = await res.json();
        endTime = Date.now() + (countdownMinutes || 30) * 60 * 1000;
      } catch {
        endTime = Date.now() + 30 * 60 * 1000;
      }

      const tick = () => {
        if (!mounted) return;
        const diff = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
        if (diff === 0) {
          setEnded(true);
          return;
        }
        setTimeLeft({
          h: Math.floor(diff / 3600),
          m: Math.floor((diff % 3600) / 60),
          s: diff % 60,
        });
      };

      tick();
      id = setInterval(tick, 1000);
    })();

    return () => {
      mounted = false;
      clearInterval(id!);
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-amber-50 flex items-center justify-center px-4">
      <div className="max-w-2xl mx-auto text-center py-12">
        <div className="mb-8">
          <div className="w-32 h-32 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <i className="ri-tools-line text-6xl text-purple-700"></i>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-6">
            We&apos;ll Be Right Back
          </h1>
          <p className="text-lg sm:text-xl text-gray-600 mb-8 leading-relaxed">
            We&apos;re currently performing scheduled maintenance to improve your shopping experience. Thank you for your patience.
          </p>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl p-8 mb-8 shadow-sm">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-4">Expected Downtime</h2>
          {timeLeft !== null && !ended ? (
            <div className="flex items-center justify-center gap-4 sm:gap-6 text-purple-700">
              <div className="flex flex-col items-center">
                <span className="text-3xl sm:text-4xl font-bold tabular-nums">{pad(timeLeft.h)}</span>
                <span className="text-xs sm:text-sm text-gray-500 uppercase tracking-wider">Hours</span>
              </div>
              <span className="text-2xl sm:text-3xl font-bold text-gray-300">:</span>
              <div className="flex flex-col items-center">
                <span className="text-3xl sm:text-4xl font-bold tabular-nums">{pad(timeLeft.m)}</span>
                <span className="text-xs sm:text-sm text-gray-500 uppercase tracking-wider">Mins</span>
              </div>
              <span className="text-2xl sm:text-3xl font-bold text-gray-300">:</span>
              <div className="flex flex-col items-center">
                <span className="text-3xl sm:text-4xl font-bold tabular-nums animate-pulse">{pad(timeLeft.s)}</span>
                <span className="text-xs sm:text-sm text-gray-500 uppercase tracking-wider">Secs</span>
              </div>
            </div>
          ) : ended ? (
            <p className="text-gray-600">We&apos;re wrapping up. Please refresh the page shortly.</p>
          ) : (
            <p className="text-gray-600">Loading countdown&hellip;</p>
          )}
        </div>

        <div className="grid sm:grid-cols-3 gap-4 sm:gap-6 mb-8">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="ri-rocket-line text-2xl text-blue-700"></i>
            </div>
            <h3 className="font-bold text-gray-900 mb-2">Performance</h3>
            <p className="text-gray-600 text-sm">Faster loading times and smoother navigation</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="ri-shield-check-line text-2xl text-purple-700"></i>
            </div>
            <h3 className="font-bold text-gray-900 mb-2">Security</h3>
            <p className="text-gray-600 text-sm">Enhanced protection for your data and transactions</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="ri-sparkle-line text-2xl text-amber-700"></i>
            </div>
            <h3 className="font-bold text-gray-900 mb-2">Features</h3>
            <p className="text-gray-600 text-sm">New functionality to enhance your experience</p>
          </div>
        </div>

        <div className="bg-purple-50 border border-purple-200 rounded-2xl p-6 sm:p-8">
          <h3 className="text-lg sm:text-xl font-bold text-gray-900 mb-4">Need Immediate Assistance?</h3>
          <p className="text-gray-600 mb-6 text-sm sm:text-base">Our customer service team is still available to help you.</p>
          <div className="flex flex-wrap gap-3 sm:gap-4 justify-center">
            <a
              href="mailto:info@kinagventures.com"
              className="inline-flex items-center gap-2 bg-white text-gray-900 px-5 py-2.5 rounded-full font-medium hover:bg-gray-50 transition-colors border border-gray-200 text-sm"
            >
              <i className="ri-mail-line"></i>
              Email Us
            </a>
            <a
              href="https://wa.me/233553610613"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-purple-700 text-white px-5 py-2.5 rounded-full font-medium hover:bg-purple-800 transition-colors text-sm"
            >
              <i className="ri-whatsapp-line"></i>
              WhatsApp
            </a>
            <a
              href="tel:+233553610613"
              className="inline-flex items-center gap-2 bg-white text-gray-900 px-5 py-2.5 rounded-full font-medium hover:bg-gray-50 transition-colors border border-gray-200 text-sm"
            >
              <i className="ri-phone-line"></i>
              Call Us
            </a>
          </div>
        </div>

        <p className="text-gray-500 text-sm mt-8">Thank you for your patience</p>
      </div>
    </div>
  );
}
