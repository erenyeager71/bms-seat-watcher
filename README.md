# BMS Seat Watcher

A Node.js and Playwright-based watcher for selected BookMyShow screenings. When it finds matching availability, it can send an alert through Telegram.

## Setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and enter your Telegram bot token and chat ID.
3. Run the primary watcher with `npm run brain`.

The scripts contain show, venue, date, screen, and row criteria that can be adjusted for the screening you want to watch.

## Safety

This repository intentionally excludes `.env`, browser/session state, cookies, generated seat captures, and debugging artifacts. Do not commit a populated `.env` file.
