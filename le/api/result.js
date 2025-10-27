import fetch from 'node-fetch';

// --- Configuration ---
const RESULT_API_BASE_URL = 'https://beu-bih.ac.in/backend/v1/result/get-result';
const FETCH_TIMEOUT = 8000; // Timeout per individual result fetch (ms)
const BATCH_SIZE = 5;       // Fixed batch size

// --- Helper: Fetch Single Result using NEW API (Returns status object) ---
async function fetchSingleResult(regNo, year, semesterRoman, encodedExamHeld) {
    const targetUrl = `${RESULT_API_BASE_URL}?year=${year}&redg_no=${regNo}&semester=${semesterRoman}&exam_held=${encodedExamHeld}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const apiResponse = await fetch(targetUrl, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': `https://beu-bih.ac.in/result-two/some-exam?semester=${semesterRoman}&session=${year}&exam_held=${encodedExamHeld}`
            }
        });
        clearTimeout(timeoutId);

        if (!apiResponse.ok) {
            return { status: 'error', regNo, reason: `BEU API Error: HTTP ${apiResponse.status}` };
        }

        const jsonData = await apiResponse.json();

        if (jsonData.status === 404) {
             return { status: 'not_found', regNo, reason: jsonData.message || 'Record not found.' };
        }
        if (jsonData.status !== 200 || !jsonData.data) {
            return { status: 'error', regNo, reason: `BEU API Data Error: ${jsonData.message || `Status ${jsonData.status}`}` };
        }

        return { status: 'success', regNo, data: jsonData.data };

    } catch (error) {
        clearTimeout(timeoutId);
        const reason = error.name === 'AbortError' ? 'Request Timed Out' : `Fetch Error: ${error.message}`;
        return { status: 'error', regNo, reason };
    }
}

// --- Main Vercel API Handler ---
export default async function handler(req, res) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET', 'OPTIONS']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    const { reg_no, year, semester, exam_held } = req.query;
    let validationError = null;
    if (!reg_no || !/^d{11}$/.test(reg_no)) { validationError = 'Invalid parameter. Use "reg_no" with full 11-digit number.'; }
    else if (!year || isNaN(parseInt(year))) { validationError = 'Missing or invalid "year".'; }
    const normalizedSemester = semester?.toUpperCase();
    const romanMap = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8 };
    if (!normalizedSemester || !romanMap[normalizedSemester]) { validationError = 'Missing or invalid "semester" (Roman I-VIII).'; }
    else if (!exam_held) { validationError = 'Missing "exam_held" parameter.'; }
    if (validationError) { return res.status(400).json({ error: validationError }); }

    const prefix = reg_no.slice(0, -3);
    const startNum = parseInt(reg_no.slice(-3), 10);
    if (isNaN(startNum)) { return res.status(400).json({ error: 'Failed to parse number from reg_no.' }); }

    const encodedExamHeld = encodeURIComponent(exam_held);
    const registrationNumbers = [];
    const endNum = startNum + BATCH_SIZE - 1;
    for (let i = startNum; i <= endNum; i++) {
        const suffix = (i >= 900) ? i.toString() : i.toString().padStart(3, '0');
        registrationNumbers.push(`${prefix}${suffix}`);
    }

    try {
        const fetchPromises = registrationNumbers.map(rn =>
            fetchSingleResult(rn, year, normalizedSemester, encodedExamHeld)
        );
        const resultsSettled = await Promise.allSettled(fetchPromises);

        const batchResponse = resultsSettled.map((result, index) => {
            const attempted = registrationNumbers[index];
            if (result.status === 'fulfilled') {
                const val = result.value;
                switch(val.status) {
                    case 'success':
                        delete val.data.father_name;
                        delete val.data.mother_name;
                        return { regNo: val.regNo, status: 'success', data: val.data };
                    case 'not_found':
                        return { regNo: val.regNo, status: 'Record not found' };
                    default:
                        return { regNo: val.regNo, status: 'Error fetching result (temporary)', reason: val.reason || 'Unknown error' };
                }
            } else {
                return { regNo: attempted, status: 'Error fetching result (temporary)', reason: 'Promise rejected' };
            }
        });

        res.status(200).json(batchResponse);
    } catch (err) {
        res.status(500).json({ error: 'Server error processing the batch.', details: err.message });
    }
}
