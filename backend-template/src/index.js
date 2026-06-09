const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { connectToWhatsApp, getStatus, restartWhatsApp } = require('./whatsapp');
const { supabase, getLojaId } = require('./supabaseClient');
require('dotenv').config();

// Middleware de Autenticação com Supabase
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token ausente ou inválido' });
    }
    const token = authHeader.split(' ')[1];
    
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ error: 'Token expirado ou inválido' });
        }
        req.lojaId = user.id; // UID do Lojista
        next();
    } catch (e) {
        return res.status(500).json({ error: 'Erro ao validar token' });
    }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Mapeamento de marcas AGSistema (fallback caso falte placa ou consulta falhe)
const MARCA_MAP = {
    1: 'Chevrolet', 2: 'Ford', 3: 'Fiat', 4: 'Volkswagen',
    5: 'Toyota', 6: 'Honda', 7: 'Hyundai', 8: 'Renault',
    9: 'Nissan', 10: 'Peugeot', 12: 'Citroën', 14: 'Mitsubishi',
    15: 'Kia', 19: 'Jeep', 25: 'BMW', 27: 'Mercedes-Benz',
    32: 'Chevrolet', 39: 'Volkswagen', 41: 'RAM', 414: 'BYD', 699: 'Caoa Chery'
};

// Função para buscar dados da placa no apiplacas
async function getPlateData(placa) {
    const token = process.env.APIPLACAS_TOKEN;
    if (!placa || !token) return null;
    
    // Limpa a placa (apenas letras e números)
    const cleanPlate = placa.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (cleanPlate.length !== 7) return null;
    
    try {
        console.log(`🔍 Consultando placa ${cleanPlate} no apiplacas...`);
        const url = `https://wdapi2.com.br/consulta/${cleanPlate}/${token}`;
        const response = await axios.get(url, { timeout: 8000 });
        const data = response.data;
        
        if (data && data.marca) {
            return {
                marca: data.marca.trim(),
                modelo: data.modelo ? data.modelo.trim() : '',
                cor: data.cor ? data.cor.trim() : null,
                ano: data.anoModelo ? parseInt(data.anoModelo) : (data.ano ? parseInt(data.ano) : null)
            };
        }
        return null;
    } catch (e) {
        console.error(`⚠️ Erro ao consultar placa ${cleanPlate}:`, e.message);
        return null;
    }
}

// Parser de XML nativo
function parseVehiclesXML(xmlText) {
    const vehicles = [];
    const vehicleRegex = /<veiculo>([\s\S]*?)<\/veiculo>/g;
    let match;
    while ((match = vehicleRegex.exec(xmlText)) !== null) {
        const content = match[1];
        const getTag = (tag) => {
            const r = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\/${tag}>`);
            const m = content.match(r);
            return m ? m[1].trim() : '';
        };

        const opcionais = [];
        const opcionalRegex = /<opcional>([\s\S]*?)<\/opcional>/g;
        let opcMatch;
        while ((opcMatch = opcionalRegex.exec(content)) !== null) {
            opcionais.push(opcMatch[1].trim());
        }

        const fotos = [];
        const imagemRegex = /<imagem>([\s\S]*?)<\/imagem>/g;
        let imgMatch;
        while ((imgMatch = imagemRegex.exec(content)) !== null) {
            fotos.push(imgMatch[1].trim());
        }

        vehicles.push({
            xml_id: getTag('id'),
            marca_id: getTag('marca'),
            modelo_id: getTag('modelo'),
            versao_id: getTag('versao'),
            cor: getTag('cor'),
            combustivel: getTag('combustivel'),
            ano: parseInt(getTag('ano')) || null,
            placa: getTag('placa'),
            km: parseInt(getTag('km')) || 0,
            preco: parseFloat(getTag('valor')) || null,
            observacao: getTag('observacao'),
            opcionais,
            fotos
        });
    }
    return vehicles;
}

// Parser de CSV nativo
function parseCSV(csvText) {
    const lines = csvText.split('\n');
    if (lines.length < 2) return [];
    
    const header = lines[0];
    const separator = header.includes(';') ? ';' : ',';
    const columns = header.split(separator).map(c => c.trim().toLowerCase().replace(/^"|"$/g, ''));
    
    const stock = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const values = line.split(separator).map(v => v.replace(/^"|"$/g, '').trim());
        const row = {};
        columns.forEach((col, idx) => {
            row[col] = values[idx] || '';
        });
        
        const marca = row['marca'] || '';
        const modelo = row['modelo'] || '';
        const versao = row['versao'] || '';
        const nome_display = row['nome'] || row['nome do veiculo'] || `${marca} ${modelo} ${versao}`.trim();
        const ano = parseInt(row['ano']) || null;
        const cor = row['cor'] || '';
        const km = parseInt(row['km']) || 0;
        const preco = parseFloat(row['preco'] || row['valor']) || null;
        const combustivel = row['combustivel'] || 'Flex';
        const cambio = row['cambio'] || 'Automático';
        const observacao = row['observacao'] || row['descricao'] || '';
        
        const fotos = [];
        if (row['foto1']) fotos.push(row['foto1']);
        if (row['foto2']) fotos.push(row['foto2']);
        if (row['foto3']) fotos.push(row['foto3']);
        
        stock.push({
            marca,
            modelo,
            versao,
            nome_display,
            ano,
            cor,
            km,
            preco,
            combustivel,
            cambio,
            fotos,
            observacao,
            disponivel: true
        });
    }
    return stock;
}

// Status do WhatsApp e QR Code
app.get('/api/status', requireAuth, (req, res) => {
    const statusData = getStatus(req.lojaId);
    res.json(statusData);
});

// Reiniciar WhatsApp para gerar novo QR Code
app.post('/api/restart-whatsapp', requireAuth, async (req, res) => {
    try {
        console.log(`🔄 Reiniciando WhatsApp da loja ${req.lojaId}...`);
        await restartWhatsApp(req.lojaId);
        res.json({ success: true, message: 'WhatsApp reiniciando. Aguarde o QR Code.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Importar estoque via URL de XML
app.post('/api/import-stock', requireAuth, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL não informada' });
    try {
        const response = await axios.get(url, { timeout: 15000 });
        const xmlData = response.data;
        
        const vehicles = parseVehiclesXML(xmlData);
        const lojaId = req.lojaId;
        
        let count = 0;
        for (const v of vehicles) {
            // 1. Verifica se já existe para economizar chamadas de consulta de placa
            const { data: existing } = await supabase
                .from('stock')
                .select('id, marca, modelo, versao, nome_display, cor, ano')
                .eq('xml_id', v.xml_id)
                .eq('loja_id', lojaId)
                .limit(1);

            let brand = '';
            let model = '';
            let version = v.versao_id || '';
            let displayName = '';
            let cor = v.cor || '';
            let ano = v.ano;

            if (existing && existing.length > 0) {
                // Se já existe, reaproveita os dados legíveis
                brand = existing[0].marca;
                model = existing[0].modelo;
                version = existing[0].versao;
                displayName = existing[0].nome_display;
                cor = existing[0].cor || cor;
                ano = existing[0].ano || ano;
            } else {
                // Se é novo, consulta no apiplacas pela placa do veículo
                let plateData = null;
                if (v.placa) {
                    plateData = await getPlateData(v.placa);
                }
                
                if (plateData) {
                    brand = plateData.marca;
                    model = plateData.modelo;
                    displayName = `${brand} ${model}`.trim();
                    cor = plateData.cor ? (plateData.cor.charAt(0).toUpperCase() + plateData.cor.slice(1).toLowerCase()) : cor;
                    ano = plateData.ano || ano;
                } else {
                    // Fallback se não conseguir consultar a placa
                    const marcaNome = MARCA_MAP[v.marca_id] || `Marca (${v.marca_id})`;
                    brand = marcaNome;
                    model = v.modelo_id || `Modelo (${v.modelo_id})`;
                    displayName = `${marcaNome} ${model} ${version}`.replace(/\s+/g, ' ').trim();
                }
            }

            const vehicleToInsert = {
                loja_id: lojaId,
                marca: brand,
                modelo: model,
                versao: version,
                nome_display: displayName,
                ano: ano,
                cor: cor,
                km: v.km,
                preco: v.preco,
                combustivel: v.combustivel,
                fotos: v.fotos,
                opcionais: v.opcionais,
                observacao: v.observacao,
                xml_id: v.xml_id,
                disponivel: true
            };

            if (existing && existing.length > 0) {
                await supabase.from('stock').update(vehicleToInsert).eq('id', existing[0].id);
            } else {
                await supabase.from('stock').insert(vehicleToInsert);
            }
            count++;
        }

        console.log(`📦 Estoque importado: ${count} veículos de ${url}`);
        res.json({ success: true, count, url });
    } catch (e) {
        console.error("Erro na importação de XML:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Importar estoque via CSV
app.post('/api/import-stock-csv', requireAuth, async (req, res) => {
    const { csvData } = req.body;
    if (!csvData) return res.status(400).json({ error: 'Dados do CSV não informados' });
    try {
        const vehicles = parseCSV(csvData);
        const lojaId = req.lojaId;
        
        let count = 0;
        for (const v of vehicles) {
            const { error } = await supabase.from('stock').insert({
                loja_id: lojaId,
                marca: v.marca,
                modelo: v.modelo,
                versao: v.versao,
                nome_display: v.nome_display,
                ano: v.ano,
                cor: v.cor,
                km: v.km,
                preco: v.preco,
                combustivel: v.combustivel,
                cambio: v.cambio,
                fotos: v.fotos,
                observacao: v.observacao,
                disponivel: true
            });
            if (!error) count++;
        }
        
        console.log(`📦 Estoque importado via CSV: ${count} veículos`);
        res.json({ success: true, count });
    } catch (e) {
        console.error("Erro na importação de CSV:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Importar estoque via SS Veículos Scraper
app.post('/api/import-scraper-ss', requireAuth, async (req, res) => {
    try {
        const lojaId = req.lojaId;
        const url = 'https://ssveiculos1.com.br/Veiculos';
        const response = await axios.get(url, { timeout: 15000 });
        const $ = cheerio.load(response.data);
        
        let count = 0;
        
        const vehiclePromises = $('.result-item').map(async (i, el) => {
            const titleElement = $(el).find('.result-item-title-new');
            const subTitleElement = $(el).find('.result-item-sub-title');
            
            const brand = titleElement.contents().filter(function() { return this.nodeType === 3; }).text().trim();
            const model = titleElement.find('b').text().trim();
            const version = subTitleElement.text().trim();
            const displayName = `${brand} ${model} ${version}`.trim();
            
            let kmText = '';
            const detailsDiv = subTitleElement.next('div');
            if (detailsDiv.length) {
                 kmText = detailsDiv.text().replace(/\s+/g, ' ').trim();
            }
            const km = parseInt(kmText.replace(/\./g, '').replace('km', '').trim()) || 0;
            
            let precoText = $(el).find('.price').text().trim();
            const preco = parseFloat(precoText.replace('R$', '').replace(/\./g, '').replace(',', '.').trim()) || 0;
            
            let imageUrl = $(el).find('img').attr('src');
            if (imageUrl && !imageUrl.startsWith('http')) {
                imageUrl = 'https://www.autocerto.com' + imageUrl; // just in case
            }
            let link = $(el).find('a.media-box').attr('href') || '';
            
            const yearMatch = link.match(/-(\d{4})\/\d+\//);
            const ano = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();
            
            const idMatch = link.match(/\/(\d+)\/detalhes/);
            const xml_id = idMatch ? `ss_${idMatch[1]}` : `ss_car_${i}`;
            
            // Upsert into Supabase
            const { data: existing } = await supabase
                .from('stock')
                .select('id')
                .eq('xml_id', xml_id)
                .eq('loja_id', lojaId)
                .limit(1);
                
            const vehicleToInsert = {
                loja_id: lojaId,
                marca: brand || 'Não informada',
                modelo: model || 'Não informado',
                versao: version,
                nome_display: displayName || 'Veículo sem nome',
                ano: ano,
                cor: 'Não informada',
                km: km,
                preco: preco,
                combustivel: 'Flex', // Default
                fotos: imageUrl ? [imageUrl] : [],
                xml_id: xml_id,
                disponivel: true
            };
            
            if (existing && existing.length > 0) {
                await supabase.from('stock').update(vehicleToInsert).eq('id', existing[0].id);
            } else {
                await supabase.from('stock').insert(vehicleToInsert);
            }
            count++;
        }).get();
        
        await Promise.all(vehiclePromises);
        
        console.log(`📦 Estoque importado via Scraper: ${count} veículos de ${url}`);
        res.json({ success: true, count, url });
    } catch (e) {
        console.error("Erro na importação via Scraper:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Adicionar vendedor
app.post('/api/sellers', requireAuth, async (req, res) => {
    const { nome, whatsapp, ordem } = req.body;
    try {
        const lojaId = req.lojaId;
        
        const { data, error } = await supabase
            .from('team_members')
            .insert({
                loja_id: lojaId,
                nome,
                whatsapp,
                ordem: parseInt(ordem) || 0,
                ativo: true
            })
            .select();
            
        if (error) throw error;
        res.json({ success: true, data: data[0] });
    } catch (e) {
        console.error("Erro ao adicionar vendedor:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Remover vendedor
app.delete('/api/sellers/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('team_members')
            .delete()
            .eq('id', id);
            
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao remover vendedor:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Remover item do estoque
app.delete('/api/stock/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('stock')
            .delete()
            .eq('id', id);
            
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao remover item do estoque:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Listar vendedores
app.get('/api/sellers', requireAuth, async (req, res) => {
    try {
        const lojaId = req.lojaId;
        
        const { data, error } = await supabase
            .from('team_members')
            .select('*')
            .eq('loja_id', lojaId)
            .order('ordem', { ascending: true });
            
        if (error) throw error;
        res.json({ success: true, data });
    } catch (e) {
        console.error("Erro ao listar vendedores:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Listar estoque
app.get('/api/stock', requireAuth, async (req, res) => {
    try {
        const lojaId = req.lojaId;
        
        const { data, error } = await supabase
            .from('stock')
            .select('*')
            .eq('loja_id', lojaId)
            .order('created_at', { ascending: false });
            
        if (error) throw error;
        res.json({ success: true, data });
    } catch (e) {
        console.error("Erro ao listar estoque:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, async () => {
    console.log(`🚀 Servidor AtndIA rodando na porta ${PORT}`);
    
    // Inicializa as sessões do WhatsApp baseadas nas lojas que existem no DB
    try {
        const { data: { users }, error } = await supabase.auth.admin.listUsers();
        console.log("Supabase Admin Auth Result:", { users: users?.length, error });
        if (users && users.length > 0) {
            console.log(`📡 Lojas encontradas: ${users.length}. Iniciando conexões...`);
            for (const user of users) {
                connectToWhatsApp(user.id);
            }
        } else {
            console.log(`📡 Nenhuma loja encontrada no Supabase.`);
        }
    } catch (e) {
        console.error("Erro ao inicializar WhatsApps:", e.message);
    }
});

