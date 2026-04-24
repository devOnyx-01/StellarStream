'use client';

import React from 'react';
import { useTimeZoneScheduler } from '@/lib/hooks/use-timezone-scheduler';

/**
 * UI Component for selecting local time and converting it to UTC Unix Timestamp.
 * Integrated with date-fns-tz as per Issue #791.
 */
export const TimeZoneScheduler: React.FC = () => {
  const {
    selectedDate,
    setSelectedDate,
    selectedTimeZone,
    setSelectedTimeZone,
    unixTimestamp
  } = useTimeZoneScheduler();

  // Retrieve supported timezones from the browser environment
  const timeZones = typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl
    ? (Intl as any).supportedValuesOf('timeZone')
    : ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Singapore'];

  return (
    <div className="p-6 bg-white rounded-xl shadow-sm border border-slate-200 max-w-md">
      <div className="mb-6">
        <h3 className="text-lg font-bold text-slate-900">Schedule Stream</h3>
        <p className="text-sm text-slate-500">Select local time for ledger release</p>
      </div>
      
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">
            Release Date & Time
          </label>
          <input
            type="datetime-local"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="w-full px-4 py-2 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">
            Your Time Zone
          </label>
          <select
            value={selectedTimeZone}
            onChange={(e) => setSelectedTimeZone(e.target.value)}
            className="w-full px-4 py-2 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
          >
            {timeZones.map((tz: string) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>

        {unixTimestamp !== undefined && (
          <div className="mt-6 p-4 bg-slate-900 rounded-lg">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                Ledger Timestamp (u64)
              </span>
              <span className="text-[10px] font-bold text-blue-400 uppercase">UTC Verified</span>
            </div>
            <div className="font-mono text-blue-100 text-lg">
              {unixTimestamp.toString()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};