/**
 * 脱敏 fixture（详设 §1.6 八条规则各一条）。
 *
 * `forbidden` 是"脱敏后不该再出现的子串"——比只比 expected 更严：
 * 只要原文的秘密还在结果里，无论其它字符怎么变都算失败。
 */
export interface RedactCase {
  name: string;
  rule: string;
  input: string;
  expected: string;
  forbidden: string;
  /** 需要打开可选规则（内网 IP） */
  privateIp?: boolean;
}

export const REDACT_CASES: readonly RedactCase[] = [
  {
    name: 'OpenAI 风格 key',
    rule: 'openai_key',
    input: 'const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234";',
    expected: 'const key = "<REDACTED:API_KEY>";',
    forbidden: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234',
  },
  {
    name: 'GitHub token',
    rule: 'github_token',
    input: 'git clone https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/x/y.git',
    expected: 'git clone https://<REDACTED:GITHUB_TOKEN>@github.com/x/y.git',
    forbidden: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  },
  {
    name: 'AWS key',
    rule: 'aws_key',
    input: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    expected: 'AWS_ACCESS_KEY_ID=<REDACTED:AWS_KEY>',
    forbidden: 'AKIAIOSFODNN7EXAMPLE',
  },
  {
    name: '私钥块（跨行）',
    rule: 'private_key',
    input: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7x9k\n-----END RSA PRIVATE KEY-----',
    expected: '<REDACTED:PRIVATE_KEY>',
    forbidden: 'MIIEowIBAAKCAQEA7x9k',
  },
  {
    name: '通用赋值',
    rule: 'generic_assign',
    input: 'password: "hunter2"',
    expected: 'password: "<REDACTED>"',
    forbidden: 'hunter2',
  },
  {
    name: 'Bearer',
    rule: 'bearer',
    input: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload',
    expected: 'Authorization: Bearer <REDACTED>',
    forbidden: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  },
  {
    name: '带用户名的绝对路径',
    rule: 'user_path',
    input: 'cat /Users/john/projects/moshi/src/main.ts',
    expected: 'cat /Users/<USER>/projects/moshi/src/main.ts',
    forbidden: 'john',
  },
  {
    name: '内网 IP（可选，默认关）',
    rule: 'private_ip',
    input: 'psql -h 192.168.1.42 -p 5432',
    expected: 'psql -h <REDACTED:PRIVATE_IP> -p 5432',
    forbidden: '192.168.1.42',
    privateIp: true,
  },
];
