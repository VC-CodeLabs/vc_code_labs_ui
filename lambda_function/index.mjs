import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { promises as fsPromises } from "fs";
import path from "path";
import https from "https";

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

    const contentType = event.headers['content-type'] || event.headers['Content-Type'];

    if (contentType.includes('multipart/form-data')) {
        const boundary = contentType.split('boundary=')[1];
        const result = Buffer.from(event.body, 'base64').toString('binary').split(new RegExp(`--${boundary}`));
        const fields = {};
        const files = [];

        for (let i = 0; i < result.length; i++) {
            if (result[i].includes('Content-Disposition: form-data;')) {
                const nameMatch = result[i].match(/name="(.+?)"/);
                if (nameMatch) {
                    const name = nameMatch[1];
                    const value = result[i].split('\r\n\r\n')[1].split('\r\n--')[0];
                    if (result[i].includes('filename=')) {
                        const filenameMatch = result[i].match(/filename="(.+?)"/);
                        if (filenameMatch) {
                            const filename = filenameMatch[1];
                            if (!filename.startsWith('.')) {
                                const filepath = `/tmp/${filename}`;
                                await fsPromises.writeFile(filepath, value, 'binary');
                                files.push({
                                    path: filepath,
                                    originalFilename: filename
                                });
                            }
                        }
                    } else {
                        fields[name] = value;
                    }
                }
            }
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

            const pullRequest = await githubRequest('POST', `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/pulls`, {
                title: `Submission from ${name} (${email})`,
                head: branchName,
                base: defaultBranch,
                body: `Code submission by ${name} (${email}).`
            });

            if (pullRequest.errors) {
                console.error('Pull Request errors:', pullRequest.errors);
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ message: 'Submission successful!' })
            };
        } catch (error) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ message: 'An error occurred.' })
            };
        }
    } else {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'Unsupported content type' })
        };
    }
};
