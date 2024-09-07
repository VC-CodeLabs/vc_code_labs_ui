import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { promises as fsPromises } from "fs";
import { createWriteStream } from "fs";
import path from "path";
import https from "https";
import Busboy from "busboy";

const secretsManager = new SecretsManagerClient({});

export const handler = async (event) => {
    const secretName = process.env.SECRET_NAME || 'GitHubTokenSecret';
    let secret;

    const headers = {
        'Access-Control-Allow-Origin': 'http://vccodelabs.s3-website-us-east-1.amazonaws.com',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST'
    };

    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    try {
        const command = new GetSecretValueCommand({ SecretId: secretName });
        const data = await secretsManager.send(command);
        if (data.SecretString) {
            secret = data.SecretString;
        } else {
            const buff = Buffer.from(data.SecretBinary, 'base64');
            secret = buff.toString('ascii');
        }
    } catch (err) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ message: 'Error retrieving secret' })
        };
    }

    const { GITHUB_TOKEN } = JSON.parse(secret);
    const repoOwner = 'VC-CodeLabs';

    if (!event.headers['content-type'].includes('multipart/form-data')) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'Unsupported content type' })
        };
    }

    const busboy = Busboy({ headers: { 'content-type': event.headers['content-type'] } });

    const fields = {};
    const files = [];

    return new Promise((resolve, reject) => {
        busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
            console.log('Received file:', { fieldname, filename, encoding, mimetype });

            // Correctly handle the filename object case
            let actualFilename = filename;
            if (typeof filename !== 'string' && typeof filename === 'object' && filename.filename) {
                actualFilename = filename.filename;
                encoding = filename.encoding;
                mimetype = filename.mimeType;
            }

            if (typeof actualFilename !== 'string' || !actualFilename.trim()) {
                console.log('Filename is invalid, generating a unique name');
                actualFilename = `upload-${Date.now()}`;
            }

            const filepath = `/tmp/${actualFilename}`;
            const writeStream = createWriteStream(filepath);

            file.pipe(writeStream);

            file.on('end', () => {
                files.push({
                    path: filepath,
                    originalFilename: actualFilename
                });
                console.log('File saved to:', filepath);
            });
        });

        busboy.on('finish', async () => {
            // Check honeypot field to prevent submissions from bots
            if (fields['honeypot'] && fields['honeypot'].trim()) {
                resolve({
                    statusCode: 403,
                    headers,
                    body: JSON.stringify({ message: 'Bot detected. Submission rejected.' })
                });
                return;
            }

            const { name, email, repo, commitMessage } = fields;
            const repoName = repo.trim();
            const branchName = name.trim();
            const folderName = name.trim();
            const commitText = commitMessage.trim();

            const githubRequest = (method, endpoint, body = null) => {
                return new Promise((resolve, reject) => {
                    const options = {
                        hostname: 'api.github.com',
                        path: endpoint,
                        method: method,
                        headers: {
                            'Authorization': `token ${GITHUB_TOKEN}`,
                            'User-Agent': 'lambda',
                            'Accept': 'application/vnd.github.v3+json',
                            'Content-Type': 'application/json'
                        }
                    };

                    const req = https.request(options, (res) => {
                        let data = '';
                        res.on('data', (chunk) => {
                            data += chunk;
                        });
                        res.on('end', () => {
                            resolve(JSON.parse(data));
                        });
                    });

                    req.on('error', (e) => {
                        reject(e);
                    });

                    if (body) {
                        req.write(JSON.stringify(body));
                    }

                    req.end();
                });
            };

            try {
                const repository = await githubRequest('GET', `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}`);

                if (repository.message === "Not Found") {
                    throw new Error(`Repository not found: ${repoOwner}/${repoName}`);
                }

                const defaultBranch = repository.default_branch;
                const ref = await githubRequest('GET', `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);

                await githubRequest('POST', `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/git/refs`, {
                    ref: `refs/heads/${branchName}`,
                    sha: ref.object.sha
                });

                for (const file of files) {
                    const filePath = `${folderName}/${path.basename(file.path)}`;
                    const fileContent = await fsPromises.readFile(file.path);

                    // Check if the file already exists to get the SHA
                    let fileSha = null;
                    try {
                        const existingFile = await githubRequest('GET', `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/contents/${encodeURIComponent(filePath)}?ref=${branchName}`);
                        fileSha = existingFile.sha;
                    } catch (error) {
                        if (error.message !== "Not Found") {
                            throw error;
                        }
                    }

                    await githubRequest('PUT', `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/contents/${encodeURIComponent(filePath)}`, {
                        message: commitText,
                        content: fileContent.toString('base64'),
                        branch: branchName,
                        sha: fileSha
                    });
                }

                // Check if a pull request already exists for the branch
                const existingPRs = await githubRequest('GET', `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/pulls?head=${repoOwner}:${branchName}`);
                if (existingPRs.length > 0) {
                    // Update the existing pull request with the new commits
                    const existingPR = existingPRs[0];
                    await githubRequest('PATCH', `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/pulls/${existingPR.number}`, {
                        title: `Updated Submission from ${name} (${email})`,
                        body: `Updated code submission by ${name} (${email}).`
                    });
                } else {
                    // Create a new pull request
                    await githubRequest('POST', `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/pulls`, {
                        title: `Submission from ${name} (${email})`,
                        head: branchName,
                        base: defaultBranch,
                        body: `Code submission by ${name} (${email}).`
                    });
                }

                resolve({
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ message: 'Submission successful!' })
                });
            } catch (error) {
                resolve({
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ message: 'An error occurred.' })
                });
            }
        });

        busboy.on('error', (error) => {
            console.error('Busboy error:', error);
            reject({
                statusCode: 500,
                headers,
                body: JSON.stringify({ message: 'Error processing file upload.' })
            });
        });

        busboy.write(Buffer.from(event.body, 'base64'));
        busboy.end();
    });
};
