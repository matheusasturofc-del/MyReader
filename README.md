# 📚 MyReader — o leitor universal

**Um só app para ler, escrever, editar e passar marca-texto em TUDO:** PDF, Word, PowerPoint,
partituras, livros EPUB, planilhas, imagens e textos. Funciona no computador, no celular e no
tablet (com caneta stylus), pode ser instalado como aplicativo e funciona offline.
Seus arquivos **nunca saem do aparelho** — tudo fica salvo localmente no navegador.

## ✨ O que ele abre

| Formato | Extensões | O que dá para fazer |
|---|---|---|
| **PDF** | `.pdf` | Ler, buscar, miniaturas, caneta, marca-texto (livre ou **sobre o texto**), notas de texto, formas, exportar PDF anotado (texto continua selecionável) |
| **Word** | `.docx` | Abrir e **editar** com barra de formatação (títulos, negrito, cores, listas, alinhamento, imagens), marca-texto de verdade, salvar em `.docx`, PDF, HTML ou TXT |
| **PowerPoint** | `.pptx`, `.ppsx`, `.potx` | Ver slides (textos, formas, imagens, tabelas, temas), notas do apresentador, **modo apresentação** em tela cheia, anotar nos slides, exportar PDF anotado |
| **Partituras MusicXML** | `.musicxml`, `.mxl`, `.xml` | Partitura renderizada página a página, **tocar** com cursor acompanhando, velocidade ajustável, anotar (dedilhado, respirações…), exportar PDF |
| **Partituras ABC** | `.abc` | **Compor** com editor ao vivo, tocar com instrumento real, transpor, exportar MIDI/PDF/ABC |
| **Partitura em PDF / imagem** | `.pdf`, `.png`, `.jpg` | Ler e anotar como qualquer PDF/imagem |
| **Livros** | `.epub` | Modo livro (páginas) ou rolagem, sumário, tamanho da letra, marca-texto com lista e exportação dos destaques |
| **Planilhas** | `.xlsx`, `.xls`, `.ods`, `.csv`, `.tsv` | Abas, editar células, marcar células com cores, exportar `.xlsx`/`.ods`/`.csv` |
| **Imagens** | `.png`, `.jpg`, `.webp`, `.gif`, `.svg`… | Desenhar, destacar, escrever por cima, exportar PNG/PDF |
| **Textos** | `.txt`, `.md`, `.html`, código… | Ler e editar; Markdown/HTML viram documento formatado |

E ainda cria do zero: **Documento** (vira `.docx`), **Caderno** (folhas pautadas, quadriculadas,
pontilhadas ou pauta musical para escrever à mão) e **Partitura** (ABC).

## 🖊️ Ferramentas

- **Caneta** com sensibilidade à pressão (stylus) e rejeição da palma
- **Marca-texto** com efeito real (o texto continua nítido por baixo): é só **arrastar o dedo por cima do texto** que ele marca na hora, encaixando em palavras inteiras (PDF, Word, EPUB). Fora do texto, risca à mão livre
- **Borracha**, **Texto**, **Formas** (retângulo, elipse, linha, seta), cores e espessuras
- **Desfazer/refazer**, zoom (botões, Ctrl+roda, pinça com 2 dedos), papel **branco / sépia / noturno**, tema claro/escuro
- Tudo é salvo automaticamente

Atalhos: `V` ler · `P` caneta · `H` marca-texto · `E` borracha · `T` texto · `R` formas ·
`Ctrl+Z` / `Ctrl+Shift+Z` · `+`/`−`/`0` zoom · `Ctrl+F` buscar no PDF.

## 🚀 Rodando

```bash
npm install
npm run dev       # desenvolvimento em http://localhost:5173
npm run build     # gera a versão final em dist/
npm run preview   # serve a versão final
```

### 📱 APK para Android

Baixe e instale: **https://github.com/matheusasturofc-del/MyReader/releases/latest/download/MyReader.apk**

O APK é gerado automaticamente pelo GitHub Actions (`.github/workflows/android.yml`) a cada push,
usando [Capacitor](https://capacitorjs.com). Para gerar localmente (precisa do Android SDK):

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug   # APK em android/app/build/outputs/apk/debug/
```

> ⚠️ Não abra o `index.html` do repositório direto no navegador — ele é o código-fonte e precisa
> ser compilado. Use o APK, `npm run dev` ou o site publicado.

### Publicar como site

O repositório já tem um workflow (`.github/workflows/deploy.yml`) que publica no **GitHub Pages**
a cada push na branch `main`. Basta ativar em *Settings → Pages → Source: GitHub Actions*.
Depois, abra o link no celular e toque em **"Adicionar à tela inicial" / "Instalar app"**.

## 🧱 Tecnologia

JavaScript puro + [Vite](https://vitejs.dev), sem framework. Bibliotecas: pdf.js, pdf-lib,
mammoth, docx, JSZip, OpenSheetMusicDisplay, abcjs, epub.js, SheetJS, marked, DOMPurify e Lucide.
O leitor de PowerPoint e o motor de anotações foram escritos do zero para este projeto.

```
src/
  main.js, nav.js, reader.js, library.js   # app, rotas, tela de leitura e biblioteca
  annotations.js                           # caneta, marca-texto, borracha, texto, formas
  viewers/                                 # um leitor por formato (pdf, doc, pptx, musicxml, abc, epub, sheet, image, notebook)
  export/                                  # exportação PDF anotado e Word (.docx)
```

### Limitações conhecidas
- Formatos antigos binários (`.doc`, `.ppt`, `.xls` funciona), `.odt` e `.rtf` não são suportados — salve como `.docx`/`.pptx`.
- No PowerPoint, gráficos e SmartArt aparecem como área marcada; animações não são reproduzidas.
- A reprodução de MusicXML usa um sintetizador simples (as partituras ABC usam instrumentos reais).
