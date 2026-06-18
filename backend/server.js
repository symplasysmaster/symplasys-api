'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const JWT_SECRET = process.env.JWT_SECRET || API_KEY || 'symplasys-local-secret';

let mongoClient = null;
let mongoDb = null;

app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

function nowIso() { return new Date().toISOString(); }
function ok(data, message, meta) { return { success: true, data: data, message: message || 'OK', version: Date.now(), meta: meta || {} }; }
function fail(message, status, details) { const e = new Error(message || 'Erro'); e.status = status || 400; e.details = details || null; return e; }
function sendError(res, error) { return res.status(error.status || 500).json({ success: false, data: null, message: error.message || 'Erro interno.', version: Date.now(), details: error.details || null }); }
function s(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function b(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
function oid() { return new ObjectId(); }
function id(v) { return v ? String(v) : ''; }
function onlyDigits(v) { return s(v).replace(/\D/g, ''); }
function hashText(text) { return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex'); }
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(Object.assign({}, payload, { iat: Date.now() }))).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token || !String(token).includes('.')) return null;
  const parts = String(token).split('.');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(parts[0]).digest('base64url');
  if (sig !== parts[1]) return null;
  try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return null; }
}
function publicDoc(doc) {
  if (!doc) return null;
  const out = Object.assign({}, doc);
  if (out._id) { out.id = String(out._id); out.mongoId = String(out._id); delete out._id; }
  delete out.Senha;
  delete out.Salt;
  delete out.senha;
  delete out.passwordHash;
  delete out.senhaCertificado;
  delete out.certificadoDigital;
  delete out.CertificadoMX;
  delete out.ChavePrivadaMX;
  delete out.NFCeToken;
  delete out.IFoodClientSecret;
  delete out.IFoodToken;
  return out;
}
function publicDocs(docs) { return (docs || []).map(publicDoc); }

async function db() {
  if (mongoDb) return mongoDb;
  if (!MONGODB_URI || !MONGODB_DB) throw fail('MONGODB_URI ou MONGODB_DB não configurado.', 500);
  mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000 });
  await mongoClient.connect();
  mongoDb = mongoClient.db(MONGODB_DB);
  return mongoDb;
}

async function count(col, filter) { return (await db()).collection(col).countDocuments(filter || {}); }
async function one(col, filter, sort) { return (await db()).collection(col).find(filter || {}).sort(sort || {}).limit(1).next(); }
async function many(col, filter, options) {
  options = options || {};
  let q = (await db()).collection(col).find(filter || {});
  if (options.sort) q = q.sort(options.sort);
  if (options.limit) q = q.limit(options.limit);
  if (options.project) q = q.project(options.project);
  return q.toArray();
}
async function insert(col, doc) { const r = await (await db()).collection(col).insertOne(doc); return Object.assign({}, doc, { _id: r.insertedId }); }
async function update(col, filter, patch, options) { return (await db()).collection(col).updateOne(filter, patch, options || {}); }
async function writeLog(tipo, payload, usuario) {
  try { await insert('symplasys_writeback_log', { LastUpdate: nowIso(), tipo, usuario: usuario || null, payload }); } catch (e) {}
}

function requireApiKey(req, res, next) {
  const key = req.query.apiKey || req.get('x-api-key') || req.body.apiKey;
  if (!API_KEY || key !== API_KEY) return res.status(401).json({ success: false, data: null, message: 'API_KEY inválida.', version: Date.now() });
  return next();
}
app.use('/api', requireApiKey);

async function getEmpresaPadrao() {
  return await one('DtoEmpresa', { Padrao: true }) || await one('DtoEmpresa', {}) || null;
}
async function getConfiguracao() { return await one('DtoConfiguracao', {}) || {}; }
async function getConfiguracaoNFe(empresaId) {
  return await one('DtoConfiguracaoNFe', empresaId ? { EmpresaID: String(empresaId) } : {}) || await one('DtoConfiguracaoNFe', {}) || {};
}
async function getConsumidorNaoIdentificado() {
  let cli = await one('DtoPessoa', { NomeFantasia: /Consumidor não identificado/i });
  if (cli) return cli;
  cli = {
    _id: oid(), LastUpdate: nowIso(), PessoaFisica: false, NomeFantasia: 'Consumidor não identificado', RazaoSocial: null,
    CNPJ_CPF: null, Cliente: false, Vendedor: false, CadastroInativo: false, Bloqueado: false, DataCadastro: nowIso()
  };
  await insert('DtoPessoa', cli);
  return cli;
}
async function nextCodigo(seqCollection, field, start) {
  const database = await db();
  const r = await database.collection(seqCollection).findOneAndUpdate(
    {},
    { $inc: { [field]: 1 }, $setOnInsert: { createdAt: nowIso() } },
    { upsert: true, returnDocument: 'after' }
  );
  return n(r.value && r.value[field]) || start || 1;
}

function matchPassword(raw, stored, salt) {
  raw = String(raw || ''); stored = String(stored || ''); salt = String(salt || '');
  if (!stored) return false;
  const candidates = [
    raw,
    hashText(raw),
    hashText(salt + raw),
    hashText(raw + salt),
    hashText(hashText(raw) + salt),
    hashText(salt + hashText(raw))
  ];
  return candidates.some(v => String(v).toLowerCase() === stored.toLowerCase());
}
async function getLocalUserByLogin(login) {
  const email = s(login).toLowerCase();
  return await one('symplasys_usuarios', { emailLower: email });
}
async function findWhiteLabelPessoaByLogin(login) {
  const loginStr = s(login);
  const rx = new RegExp('^' + loginStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  return await one('DtoPessoa', { $or: [ { EmailLoginEcommerce: rx }, { Email: rx }, { EmailComercial: rx }, { EmailFaturamento: rx }, { NomeFantasia: rx } ] });
}
function userPayloadFromPessoa(pessoa, perfil) {
  return {
    id: id(pessoa && pessoa._id),
    nome: pessoa.NomeFantasia || pessoa.RazaoSocial || pessoa.Email || 'Usuário',
    email: pessoa.EmailLoginEcommerce || pessoa.Email || pessoa.EmailComercial || '',
    perfil: perfil || (pessoa.Vendedor ? 'OPERADOR' : 'ADMIN'),
    vendedorId: pessoa.Vendedor ? id(pessoa._id) : '',
    vendedorNome: pessoa.Vendedor ? pessoa.NomeFantasia : '',
    origem: 'DtoPessoa'
  };
}
async function validarLogin(login, senha) {
  login = s(login); senha = String(senha || '');
  if (!login || !senha) throw fail('Informe login e senha.', 400);

  const totalLocal = await count('symplasys_usuarios');
  if (totalLocal === 0) {
    const pessoa = await findWhiteLabelPessoaByLogin(login);
    const salt = makeSalt();
    const doc = {
      _id: oid(), LastUpdate: nowIso(), nome: pessoa ? (pessoa.NomeFantasia || login) : login, email: login, emailLower: login.toLowerCase(),
      passwordHash: hashText(salt + senha), salt, perfil: 'MASTER', ativo: true,
      pessoaId: pessoa ? id(pessoa._id) : '', vendedorId: pessoa && pessoa.Vendedor ? id(pessoa._id) : '',
      origem: 'BOOTSTRAP_MASTER'
    };
    await insert('symplasys_usuarios', doc);
  }

  const local = await getLocalUserByLogin(login);
  if (local && local.ativo !== false && matchPassword(senha, local.passwordHash, local.salt)) {
    let pessoa = null;
    if (local.pessoaId) {
      try { pessoa = await one('DtoPessoa', { _id: new ObjectId(local.pessoaId) }); } catch(e) {}
    }
    const payload = {
      id: id(local._id), nome: local.nome || login, email: local.email, perfil: local.perfil || 'OPERADOR',
      vendedorId: local.vendedorId || (pessoa && pessoa.Vendedor ? id(pessoa._id) : ''),
      vendedorNome: local.vendedorNome || (pessoa && pessoa.Vendedor ? pessoa.NomeFantasia : ''),
      pessoaId: local.pessoaId || '', origem: 'symplasys_usuarios'
    };
    return Object.assign(payload, { token: signToken(payload) });
  }

  const pessoa = await findWhiteLabelPessoaByLogin(login);
  if (pessoa && pessoa.Bloqueado !== true && matchPassword(senha, pessoa.Senha, pessoa.Salt)) {
    const payload = userPayloadFromPessoa(pessoa, pessoa.Vendedor ? 'OPERADOR' : 'ADMIN');
    return Object.assign(payload, { token: signToken(payload) });
  }
  if (pessoa && (!pessoa.Senha || !pessoa.Salt)) throw fail('Usuário encontrado no white label, mas sem senha compatível. Cadastre o acesso no painel Usuários e vincule ao vendedor.', 401);
  throw fail('Login ou senha inválidos.', 401);
}

async function produtosNormalizados(busca, limit) {
  const filtro = busca ? { $or: [ { Nome: new RegExp(busca, 'i') }, { CodigoNFe: new RegExp(busca, 'i') }, { EAN_NFe: new RegExp(busca, 'i') }, { CodigoFornecedor: new RegExp(busca, 'i') } ] } : { OcultarNasVendas: { $ne: true } };
  const prods = await many('DtoProduto', filtro, { limit: limit || 250, sort: { Nome: 1 } });
  const ids = prods.map(p => id(p._id));
  const precos = await many('DtoProdutoPreco', ids.length ? { ProdutoID: { $in: ids } } : {}, { limit: 1000 });
  const saldos = await many('DtoEstoqueDepositoProduto', ids.length ? { ProdutoID: { $in: ids } } : {}, { limit: 1000 });
  const imgs = await many('DtoImagemProduto', ids.length ? { ProdutoID: { $in: ids }, Principal: true } : {}, { limit: 1000 });
  const precoMap = {}; precos.forEach(p => { if (!precoMap[p.ProdutoID]) precoMap[p.ProdutoID] = p; });
  const saldoMap = {}; saldos.forEach(e => { if (!saldoMap[e.ProdutoID]) saldoMap[e.ProdutoID] = e; });
  const imgMap = {}; imgs.forEach(i => { if (!imgMap[i.ProdutoID]) imgMap[i.ProdutoID] = i; });
  return prods.map(p => {
    const pid = id(p._id); const pr = precoMap[pid] || {}; const es = saldoMap[pid] || {}; const im = imgMap[pid] || {};
    return {
      id: pid, codigo: p.Codigo || p.CodigoNFe || pr.CodigoProduto || '', codigoNFe: p.CodigoNFe || '',
      nome: p.Nome || pr.Produto || '', ean: p.EAN_NFe || p.EAN_UnidadeTributavel_NFe || '',
      preco: n(pr.PrecoVenda || p.PrecoVenda), custo: n(pr.PrecoCusto || p.PrecoCusto),
      estoque: n(es.Saldo), depositoId: es.DepositoID || '', deposito: es.Deposito || '', unidade: p.EstoqueUnidade || p.UnidadeComercial_NFe || 'UN',
      categoria: p.Categoria || '', marca: p.Marca || '', ignoraEstoque: p.IgnorarEstoque === true,
      ncm: p.NCM_NFe || '', cfop: p.CFOPPadrao_NFe || '', grupoTributario: p.GrupoTributario || '',
      imagem: im.ImageUrlAwsJpeg185x139 || im.ImageUrlAwsWebp185x139 || im.ImageUrlAwsJpeg800x600 || ''
    };
  });
}
async function clientesNormalizados(busca, limit) {
  const filtro = busca ? { $or: [ { NomeFantasia: new RegExp(busca, 'i') }, { RazaoSocial: new RegExp(busca, 'i') }, { CNPJ_CPF: new RegExp(onlyDigits(busca), 'i') }, { Telefone: new RegExp(busca, 'i') }, { Celular: new RegExp(busca, 'i') } ] } : { Cliente: true, CadastroInativo: { $ne: true } };
  const docs = await many('DtoPessoa', filtro, { limit: limit || 250, sort: { NomeFantasia: 1 } });
  return docs.map(p => ({ id: id(p._id), nome: p.NomeFantasia || p.RazaoSocial || 'Sem nome', razaoSocial: p.RazaoSocial || '', cpfCnpj: p.CNPJ_CPF || '', telefone: p.Telefone || p.Celular || '', email: p.Email || p.EmailComercial || '', cidade: p.Cidade || '', uf: p.UF || '', vendedor: p.Vendedor === true, cliente: p.Cliente === true }));
}
async function vendedoresNormalizados() {
  const docs = await many('DtoPessoa', { Vendedor: true, CadastroInativo: { $ne: true }, Bloqueado: { $ne: true } }, { limit: 500, sort: { NomeFantasia: 1 } });
  return docs.map(p => ({ id: id(p._id), nome: p.NomeFantasia || p.RazaoSocial || 'Vendedor', cpfCnpj: p.CNPJ_CPF || '', email: p.Email || p.EmailLoginEcommerce || '' }));
}
async function pagamentosNormalizados() {
  const docs = await many('DtoFormaPagamento', {}, { limit: 100, sort: { Nome: 1 } });
  return docs.map(p => ({ id: id(p._id), nome: p.Nome || '' }));
}
async function getVisualConfig() {
  const empresa = await getEmpresaPadrao();
  const cfg = await one('symplasys_config_visual', {}) || {};
  return {
    nomeSistema: cfg.nomeSistema || 'SymplaSys ERP',
    nomeEmpresa: cfg.nomeEmpresa || (empresa && (empresa.NomeFantasia || empresa.RazaoSocial)) || 'Sua Empresa',
    logoUrl: cfg.logoUrl || (empresa && empresa.Logo) || '',
    corPrimaria: cfg.corPrimaria || '#262863',
    corSecundaria: cfg.corSecundaria || '#6d5dfc',
    modoEscuro: cfg.modoEscuro === true,
    textoRodape: cfg.textoRodape || 'PDV White Label'
  };
}
async function fiscalContext() {
  const empresa = await getEmpresaPadrao();
  const cfg = await getConfiguracao();
  const nfe = await getConfiguracaoNFe(empresa && empresa._id);
  const seq = await one('DtoSequencialNota', {}) || {};
  return {
    empresa: publicDoc(empresa),
    configuracao: {
      DocumentoEmissaoPDV: cfg.DocumentoEmissaoPDV || (empresa && empresa.DocumentoEmissaoPDV) || 'Nenhum',
      NFCeEmitirAutomaticamente: cfg.NFCeEmitirAutomaticamente === true,
      EscolherEmissaoDocumentoFinalizarVendaPDV: cfg.EscolherEmissaoDocumentoFinalizarVendaPDV === true,
      EmitirNFCeEmContigenciaAutomaticamente: cfg.EmitirNFCeEmContigenciaAutomaticamente === true
    },
    nfe: {
      configurado: !!(nfe && (nfe.certificadoDigital || nfe.CertificadoMX || nfe.UtilizarCertificadoA3)),
      tipoCertificado: nfe.TipoCertificado || null,
      utilizarA3: nfe.UtilizarCertificadoA3 === true,
      validadeCertificado: nfe.DataValidadeCertificadoDigital || null,
      ambienteNFe: nfe.NFEUtilizarHomologacao ? 'HOMOLOGACAO' : 'PRODUCAO',
      ambienteNFCe: nfe.NFCEUtilizarHomologacao ? 'HOMOLOGACAO' : 'PRODUCAO',
      serieNFCe: nfe.NFCeSerieNumeracao || seq.Serie || '1',
      inicioNFCe: nfe.NFCeInicioNumeracao || 0,
      proximoNFe: n(seq.NumeroNfe) + 1,
      proximoNFCe: n(seq.NumeroNfce) + 1,
      tokenConfigurado: !!(nfe.NFCeCodigoToken && nfe.NFCeToken)
    }
  };
}

app.get('/health', async (req, res) => {
  try { await db(); res.json(ok({ status: 'online', db: MONGODB_DB, hora: nowIso() }, 'API e MongoDB online.')); } catch (e) { sendError(res, e); }
});

app.post('/api/auth/login', async (req, res) => {
  try { const user = await validarLogin(req.body.login, req.body.senha); res.json(ok(user, 'Login realizado.')); } catch (e) { sendError(res, e); }
});

app.get('/api/app/boot', async (req, res) => {
  try {
    const [empresa, visual, fiscal, produtos, clientes, vendedores, formas, config] = await Promise.all([
      getEmpresaPadrao(), getVisualConfig(), fiscalContext(), produtosNormalizados('', 250), clientesNormalizados('', 250), vendedoresNormalizados(), pagamentosNormalizados(), getConfiguracao()
    ]);
    const vendasHoje = await many('DtoVenda', {}, { limit: 30, sort: { Data: -1 } });
    res.json(ok({
      fonte: 'WHITELABEL', empresa: publicDoc(empresa), visual, fiscal, produtos, clientes, vendedores, formasPagamento: formas,
      configPDV: publicDoc(config), pedidos: publicDocs(vendasHoje), dashboard: { totalProdutos: produtos.length, totalClientes: clientes.length, totalVendedores: vendedores.length, pedidosRecentes: vendasHoje.length }
    }, 'Boot white label carregado.'));
  } catch (e) { sendError(res, e); }
});

app.get('/api/pdv/boot', async (req, res) => {
  try {
    const usuario = verifyToken(req.query.token || req.get('x-session-token')) || null;
    const [empresa, visual, fiscal, produtos, clientes, vendedores, formas, consumidor] = await Promise.all([
      getEmpresaPadrao(), getVisualConfig(), fiscalContext(), produtosNormalizados('', 500), clientesNormalizados('', 300), vendedoresNormalizados(), pagamentosNormalizados(), getConsumidorNaoIdentificado()
    ]);
    let caixaAberto = null;
    if (usuario && usuario.id) caixaAberto = await one('symplasys_caixas', { usuarioId: usuario.id, status: 'ABERTO' }, { abertoEm: -1 });
    res.json(ok({ empresa: publicDoc(empresa), visual, fiscal, produtos, clientes, vendedores, formasPagamento: formas, consumidorNaoIdentificado: publicDoc(consumidor), caixaAberto: publicDoc(caixaAberto), usuario }, 'PDV carregado.'));
  } catch (e) { sendError(res, e); }
});

app.get('/api/produtos', async (req, res) => { try { res.json(ok(await produtosNormalizados(s(req.query.q), n(req.query.limit) || 500), 'Produtos carregados.')); } catch(e){sendError(res,e);} });
app.get('/api/clientes', async (req, res) => { try { res.json(ok(await clientesNormalizados(s(req.query.q), n(req.query.limit) || 500), 'Clientes carregados.')); } catch(e){sendError(res,e);} });
app.get('/api/vendedores', async (req, res) => { try { res.json(ok(await vendedoresNormalizados(), 'Vendedores carregados.')); } catch(e){sendError(res,e);} });
app.get('/api/formas-pagamento', async (req, res) => { try { res.json(ok(await pagamentosNormalizados(), 'Formas de pagamento carregadas.')); } catch(e){sendError(res,e);} });

app.post('/api/clientes', async (req, res) => {
  try {
    const d = req.body || {}; const cpf = onlyDigits(d.cpfCnpj || d.cpf || d.cnpj);
    let doc = null;
    if (cpf) doc = await one('DtoPessoa', { CNPJ_CPF: cpf });
    const payload = {
      LastUpdate: nowIso(), PessoaFisica: cpf.length <= 11, NomeFantasia: s(d.nome) || s(d.razaoSocial) || 'Cliente', RazaoSocial: s(d.razaoSocial) || s(d.nome),
      CNPJ_CPF: cpf || null, Telefone: s(d.telefone), Celular: s(d.whatsapp || d.celular), Email: s(d.email) || null,
      Cliente: true, Vendedor: b(d.vendedor), CadastroInativo: false, Bloqueado: false,
      Logradouro: s(d.logradouro) || null, LogradouroNumero: s(d.numero) || null, Bairro: s(d.bairro) || null, Cidade: s(d.cidade) || null, UF: s(d.uf) || null, CEP: onlyDigits(d.cep) || null,
      DataCadastro: nowIso()
    };
    if (doc) { await update('DtoPessoa', { _id: doc._id }, { $set: payload }); doc = Object.assign(doc, payload); }
    else { payload._id = oid(); doc = await insert('DtoPessoa', payload); }
    await writeLog('CLIENTE_WRITEBACK', { id: id(doc._id), nome: payload.NomeFantasia }, req.body.usuario || null);
    res.json(ok(publicDoc(doc), 'Cliente salvo no white label.'));
  } catch(e){sendError(res,e);}
});

app.get('/api/usuarios', async (req, res) => { try { res.json(ok(publicDocs(await many('symplasys_usuarios', {}, { sort: { nome: 1 } })), 'Usuários carregados.')); } catch(e){sendError(res,e);} });
app.post('/api/usuarios', async (req, res) => {
  try {
    const d = req.body || {}; const email = s(d.email).toLowerCase(); if (!email || !d.senha) throw fail('Informe email e senha.', 400);
    const salt = makeSalt();
    let vendedor = null;
    if (d.vendedorId) { try { vendedor = await one('DtoPessoa', { _id: new ObjectId(String(d.vendedorId)) }); } catch(e){} }
    const doc = { _id: oid(), LastUpdate: nowIso(), nome: s(d.nome) || email, email, emailLower: email, passwordHash: hashText(salt + d.senha), salt,
      perfil: s(d.perfil) || 'OPERADOR', ativo: d.ativo !== false, pessoaId: d.pessoaId || '', vendedorId: d.vendedorId || '', vendedorNome: vendedor ? vendedor.NomeFantasia : s(d.vendedorNome), permissoes: d.permissoes || ['PDV'] };
    await update('symplasys_usuarios', { emailLower: email }, { $set: doc }, { upsert: true });
    res.json(ok(publicDoc(doc), 'Usuário salvo.'));
  } catch(e){sendError(res,e);}
});

app.get('/api/caixa/aberto', async (req, res) => {
  try { res.json(ok(publicDoc(await one('symplasys_caixas', { usuarioId: s(req.query.usuarioId), status: 'ABERTO' }, { abertoEm: -1 })), 'Caixa consultado.')); } catch(e){sendError(res,e);}
});
app.post('/api/caixa/abrir', async (req, res) => {
  try {
    const d = req.body || {}; if (!d.usuarioId) throw fail('Usuário obrigatório para abrir caixa.', 400);
    const aberto = await one('symplasys_caixas', { usuarioId: s(d.usuarioId), status: 'ABERTO' }); if (aberto) return res.json(ok(publicDoc(aberto), 'Já existe caixa aberto.'));
    const empresa = await getEmpresaPadrao();
    const doc = { _id: oid(), LastUpdate: nowIso(), status: 'ABERTO', terminal: s(d.terminal) || 'PDV-01', usuarioId: s(d.usuarioId), usuarioNome: s(d.usuarioNome), vendedorId: s(d.vendedorId), vendedorNome: s(d.vendedorNome), valorInicial: n(d.valorInicial), observacaoAbertura: s(d.observacao), abertoEm: nowIso(), empresaId: empresa ? id(empresa._id) : '', empresaNome: empresa ? empresa.NomeFantasia : '' };
    await insert('symplasys_caixas', doc);
    await insert('DtoOperacaoPDV', { LastUpdate: nowIso(), TipoOperacao: 0, CaixaID: doc.usuarioId, CaixaNome: doc.usuarioNome, EmpresaID: doc.empresaId, EmpresaNome: doc.empresaNome, Data: nowIso(), UsuarioID: doc.usuarioId, UsuarioNome: doc.usuarioNome, Valores: [{ Descricao: 'Dinheiro', Pagamento: null, Valor: doc.valorInicial }], Valor: doc.valorInicial, Observacoes: doc.observacaoAbertura });
    res.json(ok(publicDoc(doc), 'Caixa aberto e enviado ao white label.'));
  } catch(e){sendError(res,e);}
});
app.post('/api/caixa/fechar', async (req, res) => {
  try {
    const d = req.body || {}; if (!d.caixaId) throw fail('Caixa obrigatório.', 400);
    const caixa = await one('symplasys_caixas', { _id: new ObjectId(String(d.caixaId)) }); if (!caixa) throw fail('Caixa não encontrado.', 404);
    const vendas = await many('symplasys_pdv_vendas', { caixaId: String(d.caixaId), status: 'CONCLUIDA' }, { limit: 5000 });
    const total = vendas.reduce((a, v) => a + n(v.total), 0);
    const informado = n(d.valorInformado);
    const patch = { status: 'FECHADO', fechadoEm: nowIso(), totalVendas: total, valorInformado: informado, diferenca: informado - (n(caixa.valorInicial) + total), observacaoFechamento: s(d.observacao), LastUpdate: nowIso() };
    await update('symplasys_caixas', { _id: caixa._id }, { $set: patch });
    await insert('DtoOperacaoPDV', { LastUpdate: nowIso(), TipoOperacao: 1, CaixaID: caixa.usuarioId, CaixaNome: caixa.usuarioNome, EmpresaID: caixa.empresaId, EmpresaNome: caixa.empresaNome, Data: nowIso(), UsuarioID: caixa.usuarioId, UsuarioNome: caixa.usuarioNome, Valores: [{ Descricao: 'Total informado', Pagamento: null, Valor: informado }], Valor: informado, StatusFechamento: Math.abs(patch.diferenca) < 0.01 ? 'Normal' : 'Divergente', ValoresInformados: d.valoresInformados || null, Observacoes: s(d.observacao) });
    res.json(ok(publicDoc(Object.assign(caixa, patch)), 'Caixa fechado e enviado ao white label.'));
  } catch(e){sendError(res,e);}
});

async function finalizarVenda(d, tipo) {
  const empresa = await getEmpresaPadrao(); const consumidor = await getConsumidorNaoIdentificado();
  const clienteId = d.clienteId || id(consumidor._id); let cliente = clienteId === id(consumidor._id) ? consumidor : null;
  if (!cliente) { try { cliente = await one('DtoPessoa', { _id: new ObjectId(String(clienteId)) }) || consumidor; } catch(e) { cliente = consumidor; } }
  let vendedorDoc = null; if (d.vendedorId) { try { vendedorDoc = await one('DtoPessoa', { _id: new ObjectId(String(d.vendedorId)) }); } catch(e){} }
  let formaDoc = null; if (d.formaPagamentoId) { try { formaDoc = await one('DtoFormaPagamento', { _id: new ObjectId(String(d.formaPagamentoId)) }); } catch(e){} }
  const codigo = await nextCodigo('DtoSequenciais', 'CodigoPedido', 1);
  const itens = Array.isArray(d.itens) ? d.itens : [];
  if (!itens.length) throw fail('Venda sem itens.', 400);
  const totalItens = itens.reduce((a, it) => a + (n(it.qtd) * n(it.preco) - n(it.desconto)), 0);
  const total = Math.max(0, totalItens - n(d.desconto) + n(d.frete) + n(d.acrescimo));
  const venda = {
    _id: oid(), LastUpdate: nowIso(), DepositoID: empresa && empresa.DepositoPadraoID || '', Deposito: empresa && empresa.DepositoPadrao || 'PADRÃO', Codigo: codigo,
    Data: nowIso(), DataAprovacaoOrcamento: tipo === 'ORCAMENTO' ? '0001-01-01T00:00:00.000Z' : nowIso(), DataAprovacaoPedido: tipo === 'ORCAMENTO' ? '0001-01-01T00:00:00.000Z' : nowIso(),
    Status: tipo === 'ORCAMENTO' ? 'Orçamento' : 'Pedido Faturado', Impresso: false, ImpressoDanfe: false, AlteradoPor: d.usuarioNome || 'SymplaSys PDV', Alteracao: nowIso(),
    EmpresaId: empresa ? id(empresa._id) : '', Empresa: empresa ? empresa.NomeFantasia : '', ClienteId: id(cliente._id), Cliente: cliente.NomeFantasia || cliente.RazaoSocial || 'Consumidor não identificado',
    VendedorID: d.vendedorId || null, VendedorPessoaID: d.vendedorId || null, Vendedor: vendedorDoc ? vendedorDoc.NomeFantasia : (d.vendedorNome || null),
    Desconto: n(d.desconto), DescontoDinheiro: n(d.desconto), ValorFrete: n(d.frete), OutrasDespesas: n(d.acrescimo), ValorFinal: total, ValorTotalSemAcrescimos: totalItens, ValorTotalComAcrescimos: total,
    Finalizado: tipo !== 'ORCAMENTO', Lancado: tipo !== 'ORCAMENTO', Enviado: false, OrigemVenda: 'SymplaSys PDV GAS', Plataforma: 'GAS',
    FormadePagamentoID: d.formaPagamentoId || null, FormadePagamento: formaDoc ? formaDoc.Nome : (d.formaPagamentoNome || ''), PlanoDeContaID: empresa && empresa.PlanoDeContaPDVID || '', PlanoDeConta: empresa && empresa.PlanoDeContaPDV || '',
    UsuarioID: d.usuarioId || '', Descricao: d.observacao || '', CPFNaNota: onlyDigits(d.cpfNota || '') || null, CaixaID: d.caixaId || null
  };
  await insert('DtoVenda', venda);
  const vendaProdutos = [];
  for (const it of itens) {
    let prod = null; try { prod = await one('DtoProduto', { _id: new ObjectId(String(it.produtoId || it.id)) }); } catch(e) {}
    const vp = { _id: oid(), LastUpdate: nowIso(), DepositoID: prod && prod.DepositoID || venda.DepositoID, Deposito: venda.Deposito, VendaID: id(venda._id), ProdutoID: id(prod && prod._id) || String(it.produtoId || it.id), Codigo: prod && prod.Codigo || it.codigo || '', CodigoNFE: prod && prod.CodigoNFe || it.codigoNFe || '', Unidade: prod && (prod.EstoqueUnidade || prod.UnidadeComercial_NFe) || 'UN', Descricao: (prod && prod.CodigoNFe ? prod.CodigoNFe + ' - ' : '') + (prod && prod.Nome || it.nome || ''), Marca: prod && prod.Marca || '', Quantidade: n(it.qtd), ValorUnitario: n(it.preco), ValorTotal: n(it.qtd) * n(it.preco) - n(it.desconto), ValorCustoUnitario: n(prod && prod.PrecoCusto), ValorCustoTotal: n(prod && prod.PrecoCusto) * n(it.qtd), DescontoTotal: n(it.desconto), Servico: prod && prod.IgnorarEstoque === true, GrupoTributario: prod && prod.GrupoTributario || null, NCM: prod && prod.NCM_NFe || null, CodigoCFOP: prod && prod.CFOPPadrao_NFe || null, IPI_Aliquota: n(prod && prod.IPI) };
    await insert('DtoVendaProduto', vp); vendaProdutos.push(vp);
    if (tipo !== 'ORCAMENTO' && !(prod && prod.IgnorarEstoque)) {
      const estoque = await one('DtoEstoqueDepositoProduto', { ProdutoID: vp.ProdutoID });
      const saldoAnterior = n(estoque && estoque.Saldo);
      if (estoque) await update('DtoEstoqueDepositoProduto', { _id: estoque._id }, { $inc: { Saldo: -n(it.qtd) }, $set: { LastUpdate: nowIso(), UltimaAtualizacao: nowIso() } });
      await insert('DtoEstoqueSaida', { _id: oid(), LastUpdate: nowIso(), CodigoProduto: vp.Codigo, CodigoProdutoNFE: String(vp.CodigoNFE || vp.Codigo || ''), VendaID: id(venda._id), ProdutoID: vp.ProdutoID, DepositoID: vp.DepositoID, Codigo: codigo, Produto: vp.Descricao, Deposito: vp.Deposito, Movimentacao: 'Venda', Quantidade: n(it.qtd), saldoMomentoMovimentacao: saldoAnterior, Unidade: vp.Unidade, ValorUnitario: vp.ValorUnitario, ValorTotal: vp.ValorTotal, Observacoes: 'Baixa de estoque ao finalizar venda no SymplaSys PDV GAS.', Cliente: venda.Cliente, ClienteID: venda.ClienteId, Data: nowIso(), VendaProdutoID: id(vp._id), UsuarioID: d.usuarioId || '', Usuario: d.usuarioNome || '' });
    }
  }
  if (tipo !== 'ORCAMENTO') {
    await insert('DtoLancamento', { _id: oid(), LastUpdate: nowIso(), LancamentoPaiId: null, EmpresaID: venda.EmpresaId, Empresa: venda.Empresa, ClienteID: venda.ClienteId, Cliente: venda.Cliente, CodigoSequencial: codigo, DataFluxo: nowIso(), DataVencimento: nowIso(), Pago: true, Conciliado: false, PlanoDeContaID: venda.PlanoDeContaID, PlanoDeConta: venda.PlanoDeConta || 'Receitas PDV', Descricao: 'Referente ao PEDIDO DE VENDA de codigo ' + codigo + ' efetuado no SymplaSys PDV GAS no valor de R$ ' + total.toFixed(2), FormaPagamentoID: venda.FormadePagamentoID, FormaPagamento: venda.FormadePagamento, Entrada: total, Saida: 0, Desconto: n(d.desconto), Despesa: false, DataPagamento: nowIso(), VendaID: id(venda._id), ValorPago: total, NumeroDocumento: 'Pedido ' + codigo, CriadoPor: d.usuarioNome || 'SymplaSys PDV GAS', ModificadoPor: d.usuarioNome || 'SymplaSys PDV GAS' });
  }
  await insert('symplasys_pdv_vendas', { _id: oid(), LastUpdate: nowIso(), vendaId: id(venda._id), codigo, tipo, status: tipo === 'ORCAMENTO' ? 'ORCAMENTO' : 'CONCLUIDA', caixaId: d.caixaId || '', usuarioId: d.usuarioId || '', usuarioNome: d.usuarioNome || '', vendedorId: d.vendedorId || '', vendedorNome: venda.Vendedor || '', clienteId: venda.ClienteId, cliente: venda.Cliente, total, formaPagamento: venda.FormadePagamento, itens: itens.length, payloadOriginal: d });
  await writeLog(tipo === 'ORCAMENTO' ? 'ORCAMENTO_WRITEBACK' : 'VENDA_WRITEBACK', { vendaId: id(venda._id), codigo, total }, d.usuarioNome || null);
  return { venda: publicDoc(venda), itens: publicDocs(vendaProdutos), codigo, total };
}
app.post('/api/pdv/venda/finalizar', async (req, res) => { try { res.json(ok(await finalizarVenda(req.body || {}, 'VENDA'), 'Venda enviada ao white label.')); } catch(e){sendError(res,e);} });
app.post('/api/orcamentos', async (req, res) => { try { res.json(ok(await finalizarVenda(req.body || {}, 'ORCAMENTO'), 'Orçamento enviado ao white label.')); } catch(e){sendError(res,e);} });
app.get('/api/pedidos', async (req, res) => { try { res.json(ok(publicDocs(await many('DtoVenda', {}, { limit: n(req.query.limit) || 100, sort: { Data: -1 } })), 'Pedidos carregados.')); } catch(e){sendError(res,e);} });
app.get('/api/orcamentos', async (req, res) => { try { res.json(ok(publicDocs(await many('DtoVenda', { Status: /Orçamento/i }, { limit: n(req.query.limit) || 100, sort: { Data: -1 } })), 'Orçamentos carregados.')); } catch(e){sendError(res,e);} });

app.get('/api/fiscal/contexto', async (req, res) => { try { res.json(ok(await fiscalContext(), 'Contexto fiscal carregado.')); } catch(e){sendError(res,e);} });
app.post('/api/fiscal/nfce/prevalidar', async (req, res) => {
  try {
    const ctx = await fiscalContext(); const erros = [];
    if (!ctx.empresa || !ctx.empresa.CNPJ) erros.push('CNPJ da empresa não configurado.');
    if (!ctx.nfe.configurado) erros.push('Certificado digital não configurado.');
    if (!ctx.nfe.tokenConfigurado) erros.push('Token NFC-e não configurado.');
    const itens = req.body.itens || []; itens.forEach((it, idx) => { if (!it.ncm) erros.push('Item ' + (idx + 1) + ' sem NCM.'); if (!it.cfop) erros.push('Item ' + (idx + 1) + ' sem CFOP.'); });
    res.json(ok({ valido: erros.length === 0, erros, contexto: ctx }, erros.length ? 'Pendências fiscais encontradas.' : 'Pré-validação aprovada.'));
  } catch(e){sendError(res,e);}
});
app.post('/api/fiscal/nfce/emitir', async (req, res) => {
  try {
    const pre = await fiscalContext();
    const doc = await insert('symplasys_fiscal_documentos', { _id: oid(), LastUpdate: nowIso(), tipo: 'NFCE', status: 'PENDENTE_API_FISCAL', vendaId: req.body.vendaId || '', payload: req.body, contextoSeguro: pre, observacao: 'Documento preparado. Conectar Focus/PlugNotas/Tecnospeed para autorização SEFAZ.' });
    res.json(ok(publicDoc(doc), 'NFC-e preparada para API fiscal externa.'));
  } catch(e){sendError(res,e);}
});

app.get('/api/etiquetas/modelos', async (req, res) => { try { res.json(ok(publicDocs(await many('symplasys_etiqueta_modelos', {}, { sort: { nome: 1 } })), 'Modelos carregados.')); } catch(e){sendError(res,e);} });
app.post('/api/etiquetas/modelos', async (req, res) => {
  try { const d = req.body || {}; const doc = { _id: oid(), LastUpdate: nowIso(), nome: s(d.nome) || 'Modelo', larguraMm: n(d.larguraMm) || 50, alturaMm: n(d.alturaMm) || 30, colunas: n(d.colunas) || 3, linhas: n(d.linhas) || 8, fonte: n(d.fonte) || 10, exibirCodigoBarras: d.exibirCodigoBarras !== false, campos: d.campos || ['nome','preco','codigo'] }; await insert('symplasys_etiqueta_modelos', doc); res.json(ok(publicDoc(doc), 'Modelo salvo.')); } catch(e){sendError(res,e);}
});

app.get('/api/whatsapp/config', async (req, res) => { try { res.json(ok(publicDoc(await one('symplasys_whatsapp_config', {}) || {}), 'Config WhatsApp carregada.')); } catch(e){sendError(res,e);} });
app.post('/api/whatsapp/config', async (req, res) => { try { const d = req.body || {}; await update('symplasys_whatsapp_config', {}, { $set: { LastUpdate: nowIso(), phoneNumberId: s(d.phoneNumberId), verifyToken: s(d.verifyToken), ativo: b(d.ativo), modoRobo: s(d.modoRobo) || 'assistido', mensagemPadrao: s(d.mensagemPadrao) } }, { upsert: true }); res.json(ok({}, 'Configuração salva.')); } catch(e){sendError(res,e);} });
app.post('/api/whatsapp/fila', async (req, res) => { try { const doc = await insert('symplasys_whatsapp_fila', { _id: oid(), LastUpdate: nowIso(), status: 'PENDENTE', tipo: s(req.body.tipo) || 'MENSAGEM', destino: s(req.body.destino), mensagem: s(req.body.mensagem), payload: req.body }); res.json(ok(publicDoc(doc), 'Mensagem colocada na fila.')); } catch(e){sendError(res,e);} });
app.get('/api/whatsapp/webhook', (req, res) => { res.send(req.query['hub.challenge'] || 'SymplaSys WhatsApp webhook'); });
app.post('/api/whatsapp/webhook', async (req, res) => { try { await insert('symplasys_whatsapp_eventos', { _id: oid(), LastUpdate: nowIso(), payload: req.body }); res.json(ok({}, 'Evento recebido.')); } catch(e){sendError(res,e);} });

app.get('/api/config/visual', async (req, res) => { try { res.json(ok(await getVisualConfig(), 'Visual carregado.')); } catch(e){sendError(res,e);} });
app.post('/api/config/visual', async (req, res) => { try { const d = req.body || {}; await update('symplasys_config_visual', {}, { $set: { LastUpdate: nowIso(), nomeSistema: s(d.nomeSistema) || 'SymplaSys ERP', nomeEmpresa: s(d.nomeEmpresa), logoUrl: s(d.logoUrl), corPrimaria: s(d.corPrimaria) || '#262863', corSecundaria: s(d.corSecundaria) || '#6d5dfc', modoEscuro: b(d.modoEscuro), textoRodape: s(d.textoRodape) } }, { upsert: true }); res.json(ok(await getVisualConfig(), 'Visual salvo.')); } catch(e){sendError(res,e);} });

app.get('/api/admin/collections', async (req, res) => {
  try { const cols = await (await db()).listCollections().toArray(); res.json(ok(cols.filter(c => !String(c.name).startsWith('system.')).map(c => ({ name: c.name, type: c.type || 'collection' })), 'Collections carregadas.')); } catch(e){sendError(res,e);}
});
app.use((req, res) => res.status(404).json({ success: false, data: null, message: 'Rota não encontrada.', version: Date.now() }));

app.listen(PORT, () => console.log('[OK] SymplaSys PDV White Label API online na porta ' + PORT));
